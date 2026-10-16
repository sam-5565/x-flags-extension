/**
 * Cache Manager - Handles storage and retrieval of profile data
 * Uses chrome.storage.local with LRU eviction
 */

class CacheManager {
  constructor() {
    this.STORAGE_KEY = 'profileCache';
    this.SETTINGS_KEY = 'extensionSettings';
    this.STATS_KEY = 'cacheStats';

    // Cache settings - long-term caching to minimize API calls
    this.DEFAULT_TTL = 30 * 24 * 60 * 60 * 1000;     // 30 days for successful lookups
    this.VERIFIED_TTL = 30 * 24 * 60 * 60 * 1000;    // 30 days for verified accounts
    this.NEGATIVE_TTL = 24 * 60 * 60 * 1000;         // 1 day when X has no data yet
    this.UNAVAILABLE_TTL = 3 * 24 * 60 * 60 * 1000;  // 3 days for suspended/unavailable
    this.PARTIAL_TTL = 6 * 60 * 60 * 1000;           // 6 hours when one query failed
    // chrome.storage.local is limited to ~10 MB without unlimitedStorage.
    this.MAX_ENTRIES = 20000;
    this.QUOTA_BYTES = 10 * 1024 * 1024;
    this.PERSIST_DELAY = 1500;                        // Batch storage writes

    // In-memory cache for quick access
    this.memoryCache = new Map();
    this.initialized = false;
    this.initPromise = null;
    this.persistTimer = null;
    this.persistPromise = null;
  }

  /**
   * Initialize cache from storage
   */
  async init() {
    if (this.initialized) return;
    if (!this.initPromise) {
      this.initPromise = this._load();
    }
    await this.initPromise;
  }

  async _load() {
    try {
      const data = await chrome.storage.local.get([this.STORAGE_KEY, this.STATS_KEY]);
      const cached = data[this.STORAGE_KEY] || {};

      // Load into memory cache, dropping entries from older versions that
      // lack a usable timestamp (they would otherwise never expire).
      let dropped = 0;
      for (const [username, rawEntry] of Object.entries(cached)) {
        const entry = this._sanitizeEntry(rawEntry, username);
        if (entry) {
          this.memoryCache.set(username.toLowerCase(), entry);
        } else {
          dropped++;
        }
      }

      this.initialized = true;

      // Older versions allowed far more entries than storage can hold.
      const before = this.memoryCache.size;
      while (this.memoryCache.size > this.MAX_ENTRIES) {
        await this._evictLRU();
      }
      if (dropped > 0 || this.memoryCache.size !== before) {
        this._schedulePersist();
      }

      XFlagLogger.log(`[CacheManager] Initialized with ${this.memoryCache.size} entries`);
    } catch (error) {
      console.error('[CacheManager] Init error:', error);
      this.initialized = true;
    }
  }

  /**
   * Get profile from cache
   * @param {string} username
   * @returns {Object|null} Cached profile data or null
   */
  async get(username) {
    await this.init();

    const key = username.toLowerCase();
    const entry = this.memoryCache.get(key);

    if (!entry) return null;

    const now = Date.now();
    const ttl = entry.ttl || this.DEFAULT_TTL;

    // Check if expired
    if (now - entry.fetchedAt > ttl) {
      // Expired, remove from cache
      this.memoryCache.delete(key);
      this._schedulePersist();
      return null;
    }

    // Update last accessed time for LRU
    entry.lastAccessed = now;
    this.memoryCache.set(key, entry);

    return entry;
  }

  /**
   * Get multiple profiles from cache
   * @param {string[]} usernames
   * @returns {Object} Map of username to cached data (or null if not cached)
   */
  async getMultiple(usernames) {
    await this.init();

    const results = {};
    for (const username of usernames) {
      results[username] = await this.get(username);
    }
    return results;
  }

  /**
   * Store profile in cache
   * @param {string} username
   * @param {Object} data Profile data
   * @param {boolean} isVerified Whether account is verified (longer TTL)
   * @param {boolean} isNegative Whether this is a "not found" result
   * @param {number} [ttlOverride] Explicit TTL in ms
   */
  async set(username, data, isVerified = false, isNegative = false, ttlOverride = null) {
    await this.init();

    const key = username.toLowerCase();
    const now = Date.now();

    let ttl = this.DEFAULT_TTL;
    if (ttlOverride > 0) {
      ttl = ttlOverride;
    } else if (isNegative) {
      ttl = this.NEGATIVE_TTL;
    } else if (isVerified) {
      ttl = this.VERIFIED_TTL;
    }

    const entry = {
      username: username,
      ...data,
      fetchedAt: now,
      lastAccessed: now,
      ttl: ttl,
      isNegative: isNegative
    };

    this.memoryCache.set(key, entry);

    // Check if we need to evict entries
    if (this.memoryCache.size > this.MAX_ENTRIES) {
      await this._evictLRU();
    }

    this._schedulePersist();

    return entry;
  }

  /**
   * Merge new data into an existing entry without discarding known fields.
   * Used for DOM-scraped data, which is often less complete than API data.
   * @param {string} username
   * @param {Object} data Partial profile data
   * @param {Object} [options]
   * @param {boolean} [options.createIfMissing=true] When false, data is only
   *   merged into an existing positive entry; returns null otherwise.
   * @returns {Object|null} The stored entry
   */
  async merge(username, data, { createIfMissing = true } = {}) {
    await this.init();

    const existing = await this.get(username);
    if (!existing || existing.isNegative) {
      if (!createIfMissing) return null;
      return this.set(username, data, Boolean(data.isVerified), false);
    }

    const merged = { ...existing };
    for (const [key, value] of Object.entries(data)) {
      if (value === null || value === undefined || value === false) continue;
      merged[key] = value;
    }
    delete merged.fetchedAt;
    delete merged.lastAccessed;
    delete merged.ttl;
    delete merged.isNegative;

    // Only new location data earns a fresh lifetime. Otherwise keep the
    // existing deadline, so a profile visit neither restarts a 30-day TTL nor
    // promotes a short-lived partial entry (which still needs its flag).
    const addsLocation = (data.basedIn && !existing.basedIn) ||
      (data.connectedVia && !existing.connectedVia) ||
      (data.isSuspended && !existing.isSuspended);
    const remaining = existing.fetchedAt + existing.ttl - Date.now();
    const ttl = addsLocation ? null : Math.max(remaining, 60 * 1000);

    return this.set(username, merged, Boolean(merged.isVerified), false, ttl);
  }

  /**
   * Remove profile from cache
   * @param {string} username
   */
  async remove(username) {
    await this.init();

    const key = username.toLowerCase();
    this.memoryCache.delete(key);
    this._schedulePersist();
  }

  /**
   * Clear entire cache
   */
  async clear() {
    await this.init();
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.memoryCache.clear();
    await chrome.storage.local.remove([this.STORAGE_KEY, this.STATS_KEY]);
    XFlagLogger.log('[CacheManager] Cache cleared');
  }

  /**
   * Get cache statistics
   * @returns {Object} Cache stats
   */
  async getStats() {
    await this.init();

    const entries = Array.from(this.memoryCache.values());
    const now = Date.now();

    let validCount = 0;
    let expiredCount = 0;
    let negativeCount = 0;

    for (const entry of entries) {
      const ttl = entry.ttl || this.DEFAULT_TTL;
      if (now - entry.fetchedAt > ttl) {
        expiredCount++;
      } else {
        validCount++;
        if (entry.isNegative) negativeCount++;
      }
    }

    // Estimate storage size
    const cacheJson = JSON.stringify(Object.fromEntries(this.memoryCache));
    const sizeBytes = new Blob([cacheJson]).size;

    return {
      totalEntries: this.memoryCache.size,
      validEntries: validCount,
      expiredEntries: expiredCount,
      negativeEntries: negativeCount,
      sizeBytes: sizeBytes,
      sizeMB: (sizeBytes / (1024 * 1024)).toFixed(2),
      maxEntries: this.MAX_ENTRIES
    };
  }

  /**
   * Export cache data
   * @returns {Object} Exportable cache data
   */
  async export() {
    await this.init();

    return {
      version: 1,
      exportedAt: Date.now(),
      entries: Object.fromEntries(this.memoryCache)
    };
  }

  /**
   * Import cache data
   * @param {Object} data Exported cache data
   * @returns {number} Number of entries imported
   */
  async import(data) {
    if (!data || typeof data.entries !== 'object' ||
        data.entries === null || Array.isArray(data.entries)) {
      throw new Error('Invalid import data');
    }
    if (data.version !== undefined && data.version !== 1) {
      throw new Error('Unsupported import version');
    }

    await this.init();

    // Refuse files that can't fit next to the existing cache instead of
    // evicting the user's real entries to make room for them.
    const incomingBytes = new Blob([JSON.stringify(data.entries)]).size;
    const currentBytes = new Blob([JSON.stringify(Object.fromEntries(this.memoryCache))]).size;
    if (incomingBytes + currentBytes > this.QUOTA_BYTES) {
      throw new Error('Import is too large for the browser\'s extension storage');
    }

    let imported = 0;
    for (const [username, rawEntry] of Object.entries(data.entries)) {
      const normalizedUsername = username.toLowerCase();

      if (!/^[a-z0-9_]{1,15}$/.test(normalizedUsername)) {
        continue;
      }

      const entry = this._sanitizeEntry(rawEntry, username);
      if (!entry) continue;

      if (this.memoryCache.size >= this.MAX_ENTRIES &&
          !this.memoryCache.has(normalizedUsername)) {
        break;
      }

      // Skip expired entries
      if (Date.now() - entry.fetchedAt <= entry.ttl) {
        this.memoryCache.set(normalizedUsername, entry);
        imported++;
      }
    }

    if (!(await this.flush())) {
      throw new Error('Imported data could not be saved');
    }
    XFlagLogger.log(`[CacheManager] Imported ${imported} entries`);

    return imported;
  }

  /**
   * Reduce an imported entry to known fields with the expected types, so a
   * hand-edited or foreign file can't put unexpected shapes into the cache.
   * @returns {Object|null} Clean entry, or null if unusable
   */
  _sanitizeEntry(entry, username) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return null;
    }

    // Clamp so a bad timestamp or a huge TTL can't make an entry immortal.
    const now = Date.now();
    const fetchedAt = Math.min(Number(entry.fetchedAt), now);
    const ttl = Math.min(Number(entry.ttl || this.DEFAULT_TTL), this.DEFAULT_TTL);
    if (!Number.isFinite(fetchedAt) || !Number.isFinite(ttl) || ttl <= 0) {
      return null;
    }

    const text = (value, max) =>
      typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;

    const place = (value) => {
      if (typeof value === 'string') {
        const country = text(value, 64);
        return country ? { country, raw: country } : null;
      }
      if (value && typeof value === 'object') {
        const country = text(value.country, 64);
        return country ? { country, raw: text(value.raw, 64) || country } : null;
      }
      return null;
    };

    const year = Number(entry.joinedYear);
    const changes = Number(entry.usernameChanges);
    const storedName = text(entry.username, 15);

    return {
      username: storedName && /^[A-Za-z0-9_]{1,15}$/.test(storedName) ? storedName : username,
      basedIn: place(entry.basedIn),
      connectedVia: place(entry.connectedVia),
      hasVpnWarning: entry.hasVpnWarning === true,
      joinedYear: Number.isInteger(year) && year >= 2006 && year <= 2100 ? year : null,
      joinedMonth: text(entry.joinedMonth, 12),
      isProtected: entry.isProtected === true,
      isVerified: entry.isVerified === true,
      isSuspended: entry.isSuspended === true,
      displayName: text(entry.displayName, 100),
      usernameChanges: Number.isInteger(changes) && changes >= 0 ? changes : null,
      fetchedAt,
      lastAccessed: Math.min(Number(entry.lastAccessed) || fetchedAt, now),
      ttl,
      isNegative: entry.isNegative === true
    };
  }

  /**
   * Evict least recently used entries
   */
  async _evictLRU() {
    const entries = Array.from(this.memoryCache.entries());

    // Sort by last accessed time (oldest first)
    entries.sort((a, b) => (a[1].lastAccessed || 0) - (b[1].lastAccessed || 0));

    // Remove oldest 10% of entries
    const toRemove = Math.ceil(entries.length * 0.1);
    for (let i = 0; i < toRemove; i++) {
      this.memoryCache.delete(entries[i][0]);
    }

    XFlagLogger.log(`[CacheManager] Evicted ${toRemove} LRU entries`);
  }

  /**
   * Write the cache to storage soon, coalescing bursts of updates into one
   * write instead of serializing the whole cache on every change.
   */
  _schedulePersist() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistPromise = this._persistCache().finally(() => {
        this.persistPromise = null;
      });
    }, this.PERSIST_DELAY);
  }

  /**
   * Write the current cache to storage now.
   * A write that is already in flight may have taken its snapshot before the
   * latest changes, so wait for it and then write again.
   * @returns {Promise<boolean>} Whether the write succeeded
   */
  async flush() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.persistPromise) {
      await this.persistPromise;
    }
    return this._persistCache();
  }

  /**
   * Persist memory cache to storage
   * @returns {Promise<boolean>} Whether the write succeeded
   */
  async _persistCache(attempt = 0) {
    try {
      const cacheObj = Object.fromEntries(this.memoryCache);
      await chrome.storage.local.set({ [this.STORAGE_KEY]: cacheObj });
      return true;
    } catch (error) {
      console.error('[CacheManager] Persist error:', error);

      // If storage quota exceeded, evict more entries and retry a few times
      if (/quota/i.test(error.message || '') && attempt < 5 && this.memoryCache.size > 0) {
        await this._evictLRU();
        await this._evictLRU(); // Evict more aggressively
        return this._persistCache(attempt + 1);
      }
      return false;
    }
  }
}

// Export for use in service worker
if (typeof self !== 'undefined') {
  self.CacheManager = CacheManager;
}
