import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sources = await Promise.all([
  'src/shared/constants.js',
  'src/shared/countries.js',
  'src/background/cache-manager.js',
  'src/background/profile-fetcher.js'
].map(file => readFile(path.join(root, file), 'utf8')));

function loadModules() {
  const storage = {};
  const context = vm.createContext({
    Blob,
    setTimeout,
    clearTimeout,
    URL,
    chrome: {
      storage: {
        local: {
          async get() { return {}; },
          async set(values) { Object.assign(storage, values); },
          async remove() {}
        }
      }
    },
    console: { ...console, warn() {}, error() {} },
    self: {}
  });

  for (const source of sources) {
    vm.runInContext(source, context);
  }

  return context.self;
}

function jsonResponse(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => headers[name.toLowerCase()] ?? null },
    async json() { return body; }
  };
}

const userByScreenName = {
  data: {
    user: {
      result: {
        __typename: 'User',
        is_blue_verified: true,
        core: { name: 'Example', created_at: 'Tue Mar 15 00:00:00 +0000 2022' },
        legacy: {}
      }
    }
  }
};

const aboutAccount = {
  data: {
    user_result_by_screen_name: {
      result: {
        about_profile: {
          account_based_in: 'Canada',
          source: 'Canada App Store',
          location_accurate: false,
          username_changes: { count: '3' }
        }
      }
    }
  }
};

function createFetcher(fetchImpl) {
  const modules = loadModules();
  const cache = new modules.CacheManager();
  const fetcher = new modules.ProfileFetcher(cache, {
    fetch: fetchImpl,
    minDelay: 0,
    callGap: 0
  });
  return { modules, cache, fetcher };
}

test('parses core fields and about profile into one cached entry', async () => {
  const { fetcher, cache } = createFetcher(async url =>
    jsonResponse(url.includes('UserByScreenName') ? userByScreenName : aboutAccount)
  );

  const data = await fetcher.fetchProfile('Example_User', 'csrf');

  assert.equal(data.joinedYear, 2022);
  assert.equal(data.joinedMonth, 'Mar');
  assert.equal(data.displayName, 'Example');
  assert.equal(data.isVerified, true);
  assert.equal(data.basedIn.country, 'Canada');
  assert.equal(data.connectedVia.country, 'Canada');
  assert.equal(data.connectedVia.raw, 'Canada App Store');
  assert.equal(data.hasVpnWarning, true);
  assert.equal(data.usernameChanges, 3);
  assert.equal((await cache.get('example_user')).basedIn.country, 'Canada');
});

test('concurrent requests for one user share a single lookup', async () => {
  let calls = 0;
  const { fetcher } = createFetcher(async url => {
    calls++;
    return jsonResponse(url.includes('UserByScreenName') ? userByScreenName : aboutAccount);
  });

  const [a, b] = await Promise.all([
    fetcher.fetchProfile('same_user', 'csrf'),
    fetcher.fetchProfile('SAME_USER', 'csrf')
  ]);

  assert.equal(calls, 2); // one UserByScreenName + one AboutAccountQuery
  assert.equal(a.basedIn.country, b.basedIn.country);

  await fetcher.fetchProfile('same_user', 'csrf');
  assert.equal(calls, 2, 'second lookup should come from the cache');
});

test('rate limiting stops further requests until the reset time', async () => {
  let calls = 0;
  const resetSeconds = Math.floor(Date.now() / 1000) + 600;
  const { fetcher } = createFetcher(async () => {
    calls++;
    return jsonResponse({}, 429, { 'x-rate-limit-reset': String(resetSeconds) });
  });

  await assert.rejects(fetcher.fetchProfile('limited_user', 'csrf'), error => {
    assert.equal(error.rateLimited, true);
    assert.equal(error.resetAt, resetSeconds * 1000);
    return true;
  });

  await assert.rejects(fetcher.fetchProfile('other_user', 'csrf'), /Rate limited/);
  assert.equal(calls, 1);
  assert.equal(fetcher.getStatus().rateLimitedUntil, resetSeconds * 1000);
});

test('unknown users are cached as negative results', async () => {
  let calls = 0;
  const { fetcher } = createFetcher(async () => {
    calls++;
    return jsonResponse({ data: {} });
  });

  const first = await fetcher.fetchProfile('ghost_user', 'csrf');
  assert.equal(first.isNegative, true);

  const second = await fetcher.fetchProfile('ghost_user', 'csrf');
  assert.equal(second.isNegative, true);
  assert.equal(calls, 2, 'negative result should not be fetched again');
});

test('failed requests are not cached', async () => {
  let calls = 0;
  const { fetcher } = createFetcher(async () => {
    calls++;
    return jsonResponse({}, 500);
  });

  const first = await fetcher.fetchProfile('flaky_user', 'csrf');
  assert.equal(first.fetchedAt, undefined);

  await fetcher.fetchProfile('flaky_user', 'csrf');
  assert.equal(calls, 4);
});

test('suspended accounts are cached without the about query', async () => {
  const urls = [];
  const { fetcher } = createFetcher(async url => {
    urls.push(url);
    return jsonResponse({ data: { user: { result: { __typename: 'UserUnavailable' } } } });
  });

  const data = await fetcher.fetchProfile('gone_user', 'csrf');
  assert.equal(data.isSuspended, true);
  assert.equal(urls.length, 1);
});

test('invalid usernames and missing CSRF tokens are rejected', async () => {
  const { fetcher } = createFetcher(async () => jsonResponse({}));

  await assert.rejects(fetcher.fetchProfile('not a user', 'csrf'), /Invalid username/);
  await assert.rejects(fetcher.fetchProfile('valid_user', null), /Not signed in/);
});
