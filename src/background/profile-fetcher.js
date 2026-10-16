/**
 * Profile Fetcher - Fetches and parses profile data from X.com
 * Serializes requests, de-duplicates concurrent lookups and backs off when X
 * rate-limits the signed-in user.
 */

// Public web-client bearer token used by x.com itself.
const X_BEARER_TOKEN =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

// GraphQL query IDs from X's own requests - these may change periodically.
const USER_BY_SCREEN_NAME_QUERY_ID = 'xmU6X_CKVnQ5lSrCbAmJsg';
const ABOUT_ACCOUNT_QUERY_ID = 'zs_jFPFT78rBpXv9Z3U2YQ';

const USER_BY_SCREEN_NAME_FEATURES = {
  hidden_profile_subscriptions_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  subscriptions_verification_info_is_identity_verified_enabled: true,
  subscriptions_verification_info_verified_since_enabled: true,
  highlights_tweets_tab_ui_enabled: true,
  responsive_web_twitter_article_notes_tab_enabled: true,
  subscriptions_feature_can_gift_premium: true,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true
};

const USERNAME_PATTERN = /^[a-z0-9_]{1,15}$/;
const DEFAULT_RATE_LIMIT_BACKOFF = 5 * 60 * 1000;

class RateLimitError extends Error {
  constructor(resetAt) {
    super('Rate limited by X');
    this.name = 'RateLimitError';
    this.rateLimited = true;
    this.resetAt = resetAt;
  }
}

/**
 * Create an empty profile record.
 */
function createEmptyProfile(username) {
  return {
    username: username,
    basedIn: null,
    connectedVia: null,
    hasVpnWarning: false,
    joinedYear: null,
    joinedMonth: null,
    isProtected: false,
    isVerified: false,
    isSuspended: false,
    displayName: null,
    usernameChanges: null
  };
}

/**
 * Whether a profile record has anything worth showing in a badge.
 */
function hasProfileData(data) {
  return Boolean(data && (data.basedIn || data.connectedVia || data.joinedYear));
}

/**
 * Parse X's created_at format: "Tue Mar 15 00:00:00 +0000 2022".
 */
function parseCreatedAt(createdAt) {
  if (typeof createdAt !== 'string') return null;

  const yearMatch = createdAt.match(/(\d{4})$/);
  if (!yearMatch) return null;

  const monthMatch = createdAt.match(/^[A-Za-z]{3} ([A-Za-z]{3})/);
  return {
    year: parseInt(yearMatch[1], 10),
    month: monthMatch ? monthMatch[1] : null
  };
}

/**
 * Copy fields shared by UserByScreenName and AboutAccountQuery results.
 * X has been moving fields from `legacy` into `core`, `privacy` and
 * `verification`, so read both shapes.
 */
function applyUserResultFields(data, userResult) {
  const legacy = userResult.legacy || {};
  const core = userResult.core || {};

  const joined = parseCreatedAt(core.created_at || legacy.created_at);
  if (joined) {
    data.joinedYear = joined.year;
    data.joinedMonth = joined.month;
  }

  const name = core.name || legacy.name;
  if (name) data.displayName = name;

  if (legacy.protected || userResult.privacy?.protected) data.isProtected = true;
  if (legacy.verified || userResult.verification?.verified ||
      userResult.is_blue_verified) {
    data.isVerified = true;
  }
}

/**
 * Parse UserByScreenName response (join date, name, protected/verified).
 * @returns {Object|null} Partial profile data, or null if no user was found
 */
function parseUserByScreenName(json, username) {
  const userResult = json?.data?.user?.result;
  if (!userResult) return null;

  const data = createEmptyProfile(username);

  if (userResult.__typename === 'UserUnavailable') {
    data.isSuspended = true;
    return data;
  }

  applyUserResultFields(data, userResult);
  return data;
}

/**
 * Parse AboutAccountQuery response ("Account based in", "Connected via").
 * @returns {Object|null} Partial profile data, or null if no user was found
 */
function parseAboutAccountResponse(json, username) {
  const userResult = json?.data?.user_result_by_screen_name?.result;
  if (!userResult) return null;

  const data = createEmptyProfile(username);

  if (userResult.__typename === 'UserUnavailable') {
    data.isSuspended = true;
    return data;
  }

  const aboutProfile = userResult.about_profile;
  if (aboutProfile) {
    if (aboutProfile.account_based_in) {
      data.basedIn = {
        country: aboutProfile.account_based_in,
        raw: aboutProfile.account_based_in
      };
    }

    // "Connected via" is called "source" in the API, e.g. "Europe Android App"
    if (aboutProfile.source) {
      data.connectedVia = {
        country: normalizeCountryName(aboutProfile.source),
        raw: aboutProfile.source
      };
    }

    // location_accurate === false means X flagged a VPN/proxy
    if (aboutProfile.location_accurate === false) {
      data.hasVpnWarning = true;
    }

    const changeCount = Number(aboutProfile.username_changes?.count);
    if (Number.isFinite(changeCount) && changeCount >= 0) {
      data.usernameChanges = changeCount;
    }
  }

  applyUserResultFields(data, userResult);
  return data;
}

/**
 * Merge two partial profile records, preferring non-empty values from `extra`.
 */
function mergeProfileData(base, extra) {
  if (!extra) return base;

  const merged = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    if (value === null || value === undefined || value === false) continue;
    merged[key] = value;
  }
  return merged;
}

class ProfileFetcher {
  /**
   * @param {CacheManager} cacheManager
   * @param {Object} [options]
   * @param {Function} [options.fetch] - fetch implementation (for tests)
   * @param {number} [options.minDelay] - Minimum ms between profile lookups
   * @param {number} [options.callGap] - Pause between the two GraphQL calls
   */
  constructor(cacheManager, options = {}) {
    this.cache = cacheManager;
    this.fetchImpl = options.fetch || ((...args) => fetch(...args));
    this.MIN_DELAY = options.minDelay ?? 1000;
    this.CALL_GAP = options.callGap ?? 300;

    this.inFlight = new Map();
    this.queueTail = Promise.resolve();
    this.queueLength = 0;
    this.lastRequestAt = 0;
    this.rateLimitedUntil = 0;
  }

  /**
   * Get a profile from the cache, or fetch it from X.
   * Concurrent requests for the same username share one network lookup.
   * @param {string} username
   * @param {string} csrfToken - ct0 cookie value from the X page
   * @returns {Promise<Object>} Cached entry or freshly fetched profile data
   */
  async fetchProfile(username, csrfToken) {
    const key = String(username || '').replace(/^@/, '').toLowerCase();
    if (!USERNAME_PATTERN.test(key)) {
      throw new Error('Invalid username');
    }

    const cached = await this.cache.get(key);
    if (cached) return cached;

    if (this.inFlight.has(key)) {
      return this.inFlight.get(key);
    }

    this._throwIfRateLimited();

    const request = this._enqueue(() => this._fetchAndCache(key, csrfToken))
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, request);
    return request;
  }

  /**
   * Run tasks one at a time with at least MIN_DELAY between them.
   */
  _enqueue(task) {
    this.queueLength++;
    const run = this.queueTail.then(async () => {
      try {
        const wait = this.lastRequestAt + this.MIN_DELAY - Date.now();
        if (wait > 0) await this._sleep(wait);
        this._throwIfRateLimited();
        return await task();
      } finally {
        this.lastRequestAt = Date.now();
        this.queueLength--;
      }
    });
    this.queueTail = run.catch(() => {});
    return run;
  }

  async _fetchAndCache(username, csrfToken) {
    const { data, complete } = await this._fetchFromX(username, csrfToken);

    if (hasProfileData(data) || data.isSuspended) {
      return this.cache.set(username, data, data.isVerified, false);
    }

    if (complete) {
      // X answered both queries but had nothing to show - remember that so
      // we don't keep asking.
      return this.cache.set(username, data, false, true);
    }

    return data;
  }

  /**
   * Query UserByScreenName (join date) and AboutAccountQuery (location).
   * @returns {Promise<{data: Object, complete: boolean}>}
   */
  async _fetchFromX(username, csrfToken) {
    if (!csrfToken) {
      throw new Error('Not signed in to X');
    }

    const headers = {
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Content-Type': 'application/json',
      'X-Twitter-Active-User': 'yes',
      'X-Twitter-Client-Language': 'en',
      'X-Csrf-Token': csrfToken,
      'Authorization': `Bearer ${X_BEARER_TOKEN}`
    };

    let data = createEmptyProfile(username);
    let complete = true;

    const userUrl = `https://x.com/i/api/graphql/${USER_BY_SCREEN_NAME_QUERY_ID}/UserByScreenName` +
      `?variables=${encodeURIComponent(JSON.stringify({
        screen_name: username,
        withSafetyModeUserFields: true
      }))}` +
      `&features=${encodeURIComponent(JSON.stringify(USER_BY_SCREEN_NAME_FEATURES))}`;

    const userJson = await this._getJson(userUrl, headers, 'UserByScreenName');
    if (userJson) {
      data = mergeProfileData(data, parseUserByScreenName(userJson, username));
    } else {
      complete = false;
    }

    // Suspended accounts have no About page.
    if (data.isSuspended) {
      return { data, complete };
    }

    await this._sleep(this.CALL_GAP);

    const aboutUrl = `https://x.com/i/api/graphql/${ABOUT_ACCOUNT_QUERY_ID}/AboutAccountQuery` +
      `?variables=${encodeURIComponent(JSON.stringify({ screenName: username }))}`;

    let aboutJson = null;
    try {
      aboutJson = await this._getJson(aboutUrl, headers, 'AboutAccountQuery');
    } catch (error) {
      // Keep the join date we already have if only the second call was limited.
      if (!(error instanceof RateLimitError) || !hasProfileData(data)) throw error;
    }

    if (aboutJson) {
      data = mergeProfileData(data, parseAboutAccountResponse(aboutJson, username));
    } else {
      complete = false;
    }

    XFlagLogger.log('[ProfileFetcher] Combined data for', username, data);
    return { data, complete };
  }

  /**
   * GET a GraphQL endpoint and return its JSON, or null on failure.
   * Throws RateLimitError on HTTP 429.
   */
  async _getJson(url, headers, label) {
    let response;
    try {
      response = await this.fetchImpl(url, { credentials: 'include', headers });
    } catch (error) {
      console.error(`[ProfileFetcher] ${label} network error:`, error);
      return null;
    }

    if (response.status === 429) {
      this._handleRateLimit(response);
      throw new RateLimitError(this.rateLimitedUntil);
    }

    if (!response.ok) {
      console.warn(`[ProfileFetcher] ${label} failed: HTTP ${response.status}`);
      return null;
    }

    try {
      return await response.json();
    } catch (error) {
      console.error(`[ProfileFetcher] ${label} returned invalid JSON:`, error);
      return null;
    }
  }

  _handleRateLimit(response) {
    const reset = parseInt(response.headers?.get?.('x-rate-limit-reset'), 10);
    const resetAt = Number.isFinite(reset) ? reset * 1000 : 0;
    const now = Date.now();

    // Ignore missing, past or absurd reset values.
    this.rateLimitedUntil = resetAt > now && resetAt - now < 60 * 60 * 1000
      ? resetAt
      : now + DEFAULT_RATE_LIMIT_BACKOFF;

    console.warn(
      '[ProfileFetcher] Rate limited by X until',
      new Date(this.rateLimitedUntil).toLocaleTimeString()
    );
  }

  _throwIfRateLimited() {
    if (Date.now() < this.rateLimitedUntil) {
      throw new RateLimitError(this.rateLimitedUntil);
    }
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get queue status
   */
  getStatus() {
    return {
      queueLength: this.queueLength,
      inFlight: Array.from(this.inFlight.keys()),
      rateLimitedUntil: Date.now() < this.rateLimitedUntil ? this.rateLimitedUntil : 0
    };
  }
}

// Export for use in service worker
if (typeof self !== 'undefined') {
  self.ProfileFetcher = ProfileFetcher;
  self.RateLimitError = RateLimitError;
  self.parseUserByScreenName = parseUserByScreenName;
  self.parseAboutAccountResponse = parseAboutAccountResponse;
  self.mergeProfileData = mergeProfileData;
  self.hasProfileData = hasProfileData;
}
