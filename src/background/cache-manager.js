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
    this.NEGATIVE_TTL = 7 * 24 * 60 * 60 * 1000;     // 7 days for failed lookups (retry sooner)
    // chrome.storage.local is limited to ~10 MB without unlimitedStorage.
    this.MAX_ENTRIES = 20000;
    this.PERSIST_DELAY = 500;                         // Batch storage writes

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

      // Load into memory cache
      for (const [username, entry] of Object.entries(cached)) {
        this.memoryCache.set(username.toLowerCase(), entry);
      }

      this.initialized = true;

      // Older versions allowed far more entries than storage can hold.
      while (this.memoryCache.size > this.MAX_ENTRIES) {
        await this._evictLRU();
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
   */
  async set(username, data, isVerified = false, isNegative = false) {
    await this.init();

    const key = username.toLowerCase();
    const now = Date.now();

    let ttl = this.DEFAULT_TTL;
    if (isNegative) {
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
   */
  async merge(username, data) {
    await this.init();

    const existing = this.memoryCache.get(username.toLowerCase());
    if (!existing || existing.isNegative) {
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

    return this.set(username, merged, Boolean(merged.isVerified), false);
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

    let imported = 0;
    for (const [username, entry] of Object.entries(data.entries)) {
      const normalizedUsername = username.toLowerCase();

      if (!/^[a-z0-9_]{1,15}$/.test(normalizedUsername) ||
          !entry || typeof entry !== 'object' || Array.isArray(entry)) {
        continue;
      }

      if (this.memoryCache.size >= this.MAX_ENTRIES &&
          !this.memoryCache.has(normalizedUsername)) {
        break;
      }

      // Skip expired entries
      const fetchedAt = Number(entry.fetchedAt);
      const ttl = Number(entry.ttl || this.DEFAULT_TTL);
      if (Number.isFinite(fetchedAt) && Number.isFinite(ttl) && ttl > 0 &&
          Date.now() - fetchedAt <= ttl) {
        this.memoryCache.set(normalizedUsername, {
          ...entry,
          username: entry.username || username,
          fetchedAt,
          lastAccessed: Number(entry.lastAccessed) || fetchedAt,
          ttl
        });
        imported++;
      }
    }

    await this.flush();
    XFlagLogger.log(`[CacheManager] Imported ${imported} entries`);

    return imported;
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
   * Write any pending changes to storage immediately.
   */
  async flush() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
      await this._persistCache();
    } else if (this.persistPromise) {
      await this.persistPromise;
    } else {
      await this._persistCache();
    }
  }

  /**
   * Persist memory cache to storage
   */
  async _persistCache(attempt = 0) {
    try {
      const cacheObj = Object.fromEntries(this.memoryCache);
      await chrome.storage.local.set({ [this.STORAGE_KEY]: cacheObj });
    } catch (error) {
      console.error('[CacheManager] Persist error:', error);

      // If storage quota exceeded, evict more entries and retry a few times
      if (/quota/i.test(error.message || '') && attempt < 5 && this.memoryCache.size > 0) {
        await this._evictLRU();
        await this._evictLRU(); // Evict more aggressively
        await this._persistCache(attempt + 1);
      }
    }
  }
}

// Export for use in service worker
if (typeof self !== 'undefined') {
  self.CacheManager = CacheManager;
}
