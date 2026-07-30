/**
 * Profile Fetcher - Fetches and parses profile data from X.com
 * Includes rate limiting, request queuing, and error handling
 */

class ProfileFetcher {
  constructor(cacheManager) {
    this.cache = cacheManager;

    // Rate limiting
    this.MIN_DELAY = 500;
    this.MAX_DELAY = 30000;
    this.BACKOFF_MULTIPLIER = 2;
    this.MAX_CONCURRENT = 3;

    // State
    this.currentDelay = this.MIN_DELAY;
    this.activeRequests = 0;
    this.queue = [];
    this.inFlightUsernames = new Set();
    this.processing = false;

    // Callbacks waiting for results
    this.pendingCallbacks = new Map();
  }

  /**
   * Fetch profile data for a username
   * Returns cached data if available, otherwise queues fetch
   * @param {string} username
   * @returns {Promise<Object>} Profile data
   */
  async fetchProfile(username) {
    const normalizedUsername = username.toLowerCase().replace('@', '');

    // Check cache first
    const cached = await this.cache.get(normalizedUsername);
    if (cached && !cached.isNegative) {
      return cached;
    }

    // If already in flight, wait for that result
    if (this.inFlightUsernames.has(normalizedUsername)) {
      return this._waitForResult(normalizedUsername);
    }

    // Queue the fetch
    return this._queueFetch(normalizedUsername);
  }

  /**
   * Fetch multiple profiles
   * @param {string[]} usernames
   * @returns {Promise<Object>} Map of username to profile data
   */
  async fetchProfiles(usernames) {
    const results = {};
    const toFetch = [];

    // Check cache for each
    for (const username of usernames) {
      const normalized = username.toLowerCase().replace('@', '');
      const cached = await this.cache.get(normalized);

      if (cached && !cached.isNegative) {
        results[normalized] = cached;
      } else {
        toFetch.push(normalized);
      }
    }

    // Fetch uncached profiles
    const fetchPromises = toFetch.map(username =>
      this.fetchProfile(username)
        .then(data => { results[username] = data; })
        .catch(error => {
          console.error(`[ProfileFetcher] Error fetching ${username}:`, error);
          results[username] = { error: error.message };
        })
    );

    await Promise.all(fetchPromises);

    return results;
  }

  /**
   * Queue a fetch request
   */
  _queueFetch(username) {
    return new Promise((resolve, reject) => {
      // Add to pending callbacks
      if (!this.pendingCallbacks.has(username)) {
        this.pendingCallbacks.set(username, []);
      }
      this.pendingCallbacks.get(username).push({ resolve, reject });

      // Add to queue if not already there
      if (!this.inFlightUsernames.has(username) && !this.queue.includes(username)) {
        this.queue.push(username);
      }

      // Start processing
      this._processQueue();
    });
  }

  /**
   * Wait for an in-flight request to complete
   */
  _waitForResult(username) {
    return new Promise((resolve, reject) => {
      if (!this.pendingCallbacks.has(username)) {
        this.pendingCallbacks.set(username, []);
      }
      this.pendingCallbacks.get(username).push({ resolve, reject });
    });
  }

  /**
   * Process the request queue
   */
  async _processQueue() {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0 && this.activeRequests < this.MAX_CONCURRENT) {
      const username = this.queue.shift();

      if (this.inFlightUsernames.has(username)) continue;

      this.inFlightUsernames.add(username);
      this.activeRequests++;

      // Don't await - let it run concurrently
      this._doFetch(username).finally(() => {
        this.activeRequests--;
        this.inFlightUsernames.delete(username);
        this._processQueue();
      });

      // Respect rate limiting
      await this._delay();
    }

    this.processing = false;
  }

  /**
   * Actually fetch and parse profile using X's GraphQL API
   */
  async _doFetch(username) {
    try {
      XFlagLogger.log(`[ProfileFetcher] Fetching profile: ${username}`);

      // Try to use X's GraphQL API for user data
      const profileData = await this._fetchViaGraphQL(username);

      if (profileData) {
        // Cache the result
        const isVerified = profileData.isVerified || false;
        await this.cache.set(username, profileData, isVerified, false);
        this._resolveCallbacks(username, profileData);
        return;
      }

      // Fallback: return empty data (user will need to visit profile manually)
      XFlagLogger.log(`[ProfileFetcher] Could not fetch data for ${username}, user needs to visit profile`);
      const emptyData = {
        username: username,
        basedIn: null,
        connectedVia: null,
        hasVpnWarning: false,
        joinedYear: null,
        isProtected: false,
        isVerified: false,
        isSuspended: false,
        displayName: null,
        needsManualVisit: true
      };
      this._resolveCallbacks(username, emptyData);

    } catch (error) {
      console.error(`[ProfileFetcher] Fetch error for ${username}:`, error);
      this._rejectCallbacks(username, error);
    }
  }

  /**
   * Fetch profile data via X's AboutAccountQuery GraphQL API
   * This endpoint provides "Account based in" and "Connected via" data
   */
  async _fetchViaGraphQL(username) {
    try {
      // X's AboutAccountQuery GraphQL endpoint - provides location data
      const variables = JSON.stringify({
        screenName: username
      });

      // Query ID for AboutAccountQuery
      const queryId = 'XRqGa7EeokUU5kppkh13EA';

      const url = `https://x.com/i/api/graphql/${queryId}/AboutAccountQuery?variables=${encodeURIComponent(variables)}`;

      XFlagLogger.log(`[ProfileFetcher] Fetching AboutAccountQuery for ${username}`);

      const response = await fetch(url, {
        credentials: 'include',
        headers: {
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Content-Type': 'application/json',
          'X-Twitter-Active-User': 'yes',
          'X-Twitter-Client-Language': 'en'
        }
      });

      if (response.status === 429) {
        console.warn('[ProfileFetcher] Rate limited on GraphQL');
        this.currentDelay = Math.min(this.currentDelay * this.BACKOFF_MULTIPLIER, this.MAX_DELAY);
        return null;
      }

      if (!response.ok) {
        XFlagLogger.log(`[ProfileFetcher] AboutAccountQuery failed: ${response.status}`);
        return null;
      }

      const json = await response.json();
      XFlagLogger.log(`[ProfileFetcher] AboutAccountQuery response for ${username}:`, JSON.stringify(json).substring(0, 1000));

      return this._parseAboutAccountResponse(json, username);

    } catch (error) {
      console.error(`[ProfileFetcher] GraphQL fetch error:`, error);
      return null;
    }
  }

  /**
   * Parse AboutAccountQuery GraphQL API response
   */
  _parseAboutAccountResponse(json, username) {
    const data = {
      username: username,
      basedIn: null,
      connectedVia: null,
      hasVpnWarning: false,
      joinedYear: null,
      joinedMonth: null,
      isProtected: false,
      isVerified: false,
      isSuspended: false,
      displayName: null
    };

    try {
      // Navigate to the about_profile data
      const userResult = json?.data?.user_result_by_screen_name?.result;

      if (!userResult) {
        XFlagLogger.log(`[ProfileFetcher] No user data in AboutAccountQuery response`);
        return null;
      }

      // Check for suspended/unavailable
      if (userResult.__typename === 'UserUnavailable') {
        data.isSuspended = true;
        return data;
      }

      const aboutProfile = userResult.about_profile;

      if (aboutProfile) {
        // Extract "Account based in" location
        if (aboutProfile.account_based_in) {
          data.basedIn = {
            country: aboutProfile.account_based_in,
            raw: aboutProfile.account_based_in
          };
          XFlagLogger.log(`[ProfileFetcher] Found basedIn: ${aboutProfile.account_based_in}`);
        }

        // Extract "Connected via" (device/app store region)
        if (aboutProfile.connected_via) {
          // Parse region from "Europe Android App" -> "Europe"
          const connectedVia = aboutProfile.connected_via;
          const regionMatch = connectedVia.match(/^([A-Za-z\s]+?)(?:\s+(?:Android|iOS|Web|App|Store))/i);
          const region = regionMatch ? regionMatch[1].trim() : connectedVia;

          data.connectedVia = {
            country: region,
            raw: connectedVia
          };
          XFlagLogger.log(`[ProfileFetcher] Found connectedVia: ${connectedVia}`);
        }

        // Check for VPN warning indicator
        if (aboutProfile.has_location_warning || aboutProfile.location_mismatch) {
          data.hasVpnWarning = true;
          XFlagLogger.log(`[ProfileFetcher] Found VPN warning`);
        }

        // Extract join date
        if (aboutProfile.joined) {
          const joinMatch = aboutProfile.joined.match(/([A-Za-z]+)\s+(\d{4})/);
          if (joinMatch) {
            data.joinedMonth = joinMatch[1];
            data.joinedYear = parseInt(joinMatch[2], 10);
            XFlagLogger.log(`[ProfileFetcher] Found joined: ${data.joinedMonth} ${data.joinedYear}`);
          }
        }

        // Alternative: created_at field
        if (!data.joinedYear && aboutProfile.created_at) {
          const match = aboutProfile.created_at.match(/(\d{4})$/);
          if (match) {
            data.joinedYear = parseInt(match[1], 10);
          }
        }
      }

      // Also check legacy data if available
      const legacy = userResult.legacy;
      if (legacy) {
        if (!data.joinedYear && legacy.created_at) {
          const match = legacy.created_at.match(/(\d{4})$/);
          if (match) {
            data.joinedYear = parseInt(match[1], 10);
          }
          const monthMatch = legacy.created_at.match(/^[A-Za-z]{3} ([A-Za-z]{3})/);
          if (monthMatch) {
            data.joinedMonth = monthMatch[1];
          }
        }

        if (legacy.name) {
          data.displayName = legacy.name;
        }

        if (legacy.protected) {
          data.isProtected = true;
        }

        if (legacy.verified) {
          data.isVerified = true;
        }
      }

      // Check blue verification
      if (userResult.is_blue_verified) {
        data.isVerified = true;
      }

      XFlagLogger.log(`[ProfileFetcher] Parsed AboutAccount data for ${username}:`, JSON.stringify(data));
      return data;

    } catch (error) {
      console.error('[ProfileFetcher] AboutAccount parse error:', error);
      return null;
    }
  }

  /**
   * Parse profile HTML to extract relevant data
   * X.com embeds user data in JSON within script tags
   */
  _parseProfileHtml(html, username) {
    const data = {
      username: username,
      basedIn: null,
      connectedVia: null,
      hasVpnWarning: false,
      joinedYear: null,
      isProtected: false,
      isVerified: false,
      isSuspended: false,
      displayName: null
    };

    try {
      // Check for suspended account
      if (html.includes('Account suspended') || html.includes('This account has been suspended')) {
        data.isSuspended = true;
        return data;
      }

      // Try to find embedded JSON data in script tags
      // X.com often embeds __INITIAL_STATE__ or similar
      const scriptMatches = html.match(/<script[^>]*>([^<]*__INITIAL_STATE__[^<]*)<\/script>/i) ||
                           html.match(/<script[^>]*type="application\/json"[^>]*>([^<]+)<\/script>/g);

      if (scriptMatches) {
        XFlagLogger.log(`[ProfileFetcher] Found script tags with potential data for ${username}`);
      }

      // Look for user data in JSON format embedded in the page
      // Pattern: "created_at":"Day Mon DD HH:MM:SS +0000 YYYY"
      const createdAtMatch = html.match(/"created_at"\s*:\s*"[A-Za-z]{3} ([A-Za-z]{3}) \d{2} [\d:]+ \+\d{4} (\d{4})"/);
      if (createdAtMatch) {
        data.joinedYear = parseInt(createdAtMatch[2], 10);
        data.joinedMonth = createdAtMatch[1];
        XFlagLogger.log(`[ProfileFetcher] Found created_at year: ${data.joinedYear}`);
      }

      // Alternative: look for "Joined Month Year" in any format
      const joinedMatch = html.match(/Joined\s+([A-Za-z]+)\s+(\d{4})/i) ||
                         html.match(/"joined"\s*:\s*"([A-Za-z]+)\s+(\d{4})"/i);
      if (joinedMatch && !data.joinedYear) {
        data.joinedYear = parseInt(joinedMatch[2], 10);
        data.joinedMonth = joinedMatch[1];
        XFlagLogger.log(`[ProfileFetcher] Found joined: ${joinedMatch[1]} ${joinedMatch[2]}`);
      }

      // Look for location data in JSON
      // Pattern: "location":"Country Name"
      const locationMatch = html.match(/"location"\s*:\s*"([^"]+)"/);
      if (locationMatch && locationMatch[1]) {
        const location = locationMatch[1].trim();
        if (location && location.length > 0 && location !== 'null') {
          data.basedIn = {
            country: location,
            raw: location
          };
          XFlagLogger.log(`[ProfileFetcher] Found location: ${location}`);
        }
      }

      // Look for verified status
      if (html.includes('"verified":true') || html.includes('"is_blue_verified":true')) {
        data.isVerified = true;
      }

      // Look for protected status
      if (html.includes('"protected":true')) {
        data.isProtected = true;
      }

      // Look for screen_name to verify we have the right user
      const screenNameMatch = html.match(/"screen_name"\s*:\s*"([^"]+)"/i);
      if (screenNameMatch) {
        XFlagLogger.log(`[ProfileFetcher] Found screen_name: ${screenNameMatch[1]}`);
      }

      // Look for name (display name)
      const nameMatch = html.match(/"name"\s*:\s*"([^"]+)"/);
      if (nameMatch && nameMatch[1]) {
        data.displayName = nameMatch[1];
      }

      // Extract display name from title as fallback
      if (!data.displayName) {
        const titleMatch = html.match(/<title>([^<]+)<\/title>/);
        if (titleMatch) {
          const displayNameMatch = titleMatch[1].match(/^([^(@]+)/);
          if (displayNameMatch) {
            data.displayName = displayNameMatch[1].trim();
          }
        }
      }

      XFlagLogger.log(`[ProfileFetcher] Parsed data for ${username}:`, JSON.stringify(data));

    } catch (error) {
      console.error('[ProfileFetcher] Parse error:', error);
    }

    return data;
  }

  /**
   * Resolve all pending callbacks for a username
   */
  _resolveCallbacks(username, data) {
    const callbacks = this.pendingCallbacks.get(username) || [];
    this.pendingCallbacks.delete(username);

    for (const { resolve } of callbacks) {
      resolve(data);
    }
  }

  /**
   * Reject all pending callbacks for a username
   */
  _rejectCallbacks(username, error) {
    const callbacks = this.pendingCallbacks.get(username) || [];
    this.pendingCallbacks.delete(username);

    for (const { reject } of callbacks) {
      reject(error);
    }
  }

  /**
   * Delay with current backoff
   */
  _delay() {
    return new Promise(resolve => setTimeout(resolve, this.currentDelay));
  }

  /**
   * Get queue status
   */
  getStatus() {
    return {
      queueLength: this.queue.length,
      activeRequests: this.activeRequests,
      currentDelay: this.currentDelay,
      inFlight: Array.from(this.inFlightUsernames)
    };
  }
}

// Export for use in service worker
if (typeof self !== 'undefined') {
  self.ProfileFetcher = ProfileFetcher;
}
