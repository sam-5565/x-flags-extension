import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const constantsSource = await readFile(
  path.join(root, 'src/shared/constants.js'),
  'utf8'
);
const cacheManagerSource = await readFile(
  path.join(root, 'src/background/cache-manager.js'),
  'utf8'
);

function createCacheManager() {
  const storage = {};
  const context = vm.createContext({
    Blob,
    setTimeout,
    clearTimeout,
    chrome: {
      storage: {
        local: {
          async get(keys) {
            return Object.fromEntries(
              keys
                .filter(key => Object.hasOwn(storage, key))
                .map(key => [key, storage[key]])
            );
          },
          async set(values) {
            Object.assign(storage, values);
          },
          async remove(keys) {
            for (const key of keys) delete storage[key];
          }
        }
      }
    },
    console,
    self: {}
  });

  vm.runInContext(constantsSource, context);
  vm.runInContext(cacheManagerSource, context);

  return {
    cache: new context.self.CacheManager(),
    storage
  };
}

test('cache keys are case-insensitive', async () => {
  const { cache } = createCacheManager();
  await cache.set('Example_User', { joinedYear: 2020 });

  const entry = await cache.get('example_user');
  assert.equal(entry.username, 'Example_User');
  assert.equal(entry.joinedYear, 2020);
});

test('imports valid entries and skips expired or malformed entries', async () => {
  const { cache } = createCacheManager();
  const now = Date.now();

  const imported = await cache.import({
    version: 1,
    entries: {
      valid_user: {
        username: 'valid_user',
        joinedYear: 2021,
        fetchedAt: now,
        lastAccessed: now,
        ttl: 60_000
      },
      expired_user: {
        username: 'expired_user',
        joinedYear: 2019,
        fetchedAt: now - 120_000,
        ttl: 60_000
      },
      'not a username': {
        fetchedAt: now,
        ttl: 60_000
      },
      malformed_user: {
        fetchedAt: 'not-a-timestamp',
        ttl: 60_000
      }
    }
  });

  assert.equal(imported, 1);
  assert.equal((await cache.get('valid_user')).joinedYear, 2021);
  assert.equal(await cache.get('expired_user'), null);
});

test('rejects unsupported or invalid import formats', async () => {
  const { cache } = createCacheManager();

  await assert.rejects(
    cache.import({ version: 2, entries: {} }),
    /Unsupported import version/
  );
  await assert.rejects(
    cache.import({ version: 1, entries: [] }),
    /Invalid import data/
  );
});

test('writes are batched and flushed to storage', async () => {
  const { cache, storage } = createCacheManager();
  await cache.set('first_user', { joinedYear: 2010 });
  await cache.set('second_user', { joinedYear: 2011 });

  assert.equal(storage.profileCache, undefined);
  await cache.flush();
  assert.deepEqual(Object.keys(storage.profileCache).sort(), ['first_user', 'second_user']);
});

test('merge keeps existing fields that new data lacks', async () => {
  const { cache } = createCacheManager();
  await cache.set('merged_user', {
    basedIn: { country: 'Canada', raw: 'Canada' },
    joinedYear: 2015,
    hasVpnWarning: true
  });

  const entry = await cache.merge('merged_user', {
    basedIn: null,
    joinedYear: 2015,
    isProtected: true,
    hasVpnWarning: false
  });

  assert.equal(entry.basedIn.country, 'Canada');
  assert.equal(entry.hasVpnWarning, true);
  assert.equal(entry.isProtected, true);
  assert.equal(entry.isNegative, false);
});

test('negative entries are returned until they expire', async () => {
  const { cache } = createCacheManager();
  await cache.set('missing_user', { basedIn: null }, false, true);

  const entry = await cache.get('missing_user');
  assert.equal(entry.isNegative, true);
  assert.equal(entry.ttl, cache.NEGATIVE_TTL);
});

test('merge without createIfMissing leaves absent and negative entries alone', async () => {
  const { cache } = createCacheManager();

  assert.equal(
    await cache.merge('nobody', { joinedYear: 2012 }, { createIfMissing: false }),
    null
  );
  assert.equal(await cache.get('nobody'), null);

  await cache.set('negative_user', {}, false, true);
  assert.equal(
    await cache.merge('negative_user', { joinedYear: 2012 }, { createIfMissing: false }),
    null
  );
  assert.equal((await cache.get('negative_user')).isNegative, true);

  await cache.set('known_user', { basedIn: { country: 'Peru', raw: 'Peru' } });
  const merged = await cache.merge('known_user', { joinedYear: 2012 }, { createIfMissing: false });
  assert.equal(merged.joinedYear, 2012);
  assert.equal(merged.basedIn.country, 'Peru');
});

test('explicit TTL overrides the default', async () => {
  const { cache } = createCacheManager();
  const entry = await cache.set('short_user', { joinedYear: 2020 }, false, false, 1234);
  assert.equal(entry.ttl, 1234);
});

test('imported entries are reduced to known, well-typed fields', async () => {
  const { cache } = createCacheManager();
  const now = Date.now();

  await cache.import({
    version: 1,
    entries: {
      odd_user: {
        fetchedAt: now,
        basedIn: 'France',
        connectedVia: { country: 42 },
        joinedYear: '2015',
        isVerified: 'yes',
        hasVpnWarning: true,
        extraField: { nested: true },
        isNegative: 'false'
      }
    }
  });

  const entry = await cache.get('odd_user');
  assert.equal(entry.basedIn.country, 'France');
  assert.equal(entry.basedIn.raw, 'France');
  assert.equal(entry.connectedVia, null);
  assert.equal(entry.joinedYear, 2015);
  assert.equal(entry.isVerified, false);
  assert.equal(entry.hasVpnWarning, true);
  assert.equal(entry.isNegative, false);
  assert.equal('extraField' in entry, false);
});
