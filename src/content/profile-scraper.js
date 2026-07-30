/**
 * Profile Scraper - Extracts profile data from the rendered DOM
 * Works by scraping data when user visits a profile page
 */

const ProfileScraper = {
  // Track which profiles we've scraped
  scrapedProfiles: new Map(),

  // Check interval for profile page
  checkInterval: null,

  // Initialization state
  initialized: false,

  /**
   * Initialize the scraper
   */
  async init() {
    XFlagLogger.log('[ProfileScraper] Initializing...');

    // Load cached profiles from background on init
    await this._loadFromCache();

    this._startMonitoring();
    this.initialized = true;
  },

  /**
   * Load previously cached profiles from background storage
   */
  async _loadFromCache() {
    try {
      // Try to get all cached data from background
      const response = await chrome.runtime.sendMessage({
        type: 'GET_ALL_CACHED_PROFILES'
      });

      if (response && response.data) {
        for (const [username, profileData] of Object.entries(response.data)) {
          if (profileData &&
              (profileData.joinedYear || profileData.basedIn || profileData.connectedVia)) {
            this.scrapedProfiles.set(username.toLowerCase(), profileData);
          }
        }
        XFlagLogger.log('[ProfileScraper] Loaded', this.scrapedProfiles.size, 'profiles from cache');
      }
    } catch (error) {
      XFlagLogger.log('[ProfileScraper] Could not load from cache:', error.message);
    }
  },

  /**
   * Start monitoring for profile pages
   */
  _startMonitoring() {
    // Check immediately
    this._checkForProfilePage();

    // Also check on URL changes (X uses client-side routing)
    let lastUrl = location.href;

    const urlObserver = new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        // Small delay to let page render
        setTimeout(() => this._checkForProfilePage(), 1000);
      }
    });

    urlObserver.observe(document.body, { childList: true, subtree: true });
  },

  /**
   * Check if we're on a profile page and scrape data
   */
  _checkForProfilePage() {
    const path = window.location.pathname;

    // Match /{username} or /{username}/about patterns
    const profileMatch = path.match(/^\/([A-Za-z0-9_]{1,15})(\/about)?$/);

    if (!profileMatch) {
      return;
    }

    const username = profileMatch[1].toLowerCase();

    // Skip reserved paths
    const reservedPaths = [
      'home', 'explore', 'search', 'notifications', 'messages',
      'i', 'settings', 'compose', 'lists', 'bookmarks', 'communities',
      'premium', 'jobs', 'live', 'topics', 'moments', 'help', 'tos',
      'privacy', 'about', 'ads', 'business', 'developers', 'directory'
    ];

    if (reservedPaths.includes(username)) {
      return;
    }

    XFlagLogger.log(`[ProfileScraper] On profile page for: ${username}`);

    // Wait a bit for content to load, then scrape
    setTimeout(() => this._scrapeProfileData(username), 1500);
  },

  /**
   * Scrape profile data from the current page
   */
  async _scrapeProfileData(username) {
    XFlagLogger.log(`[ProfileScraper] Scraping data for: ${username}`);

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
      displayName: null,
      scrapedAt: Date.now()
    };

    try {
      // Check for suspended account
      const suspendedText = document.body.innerText;
      if (suspendedText.includes('Account suspended') ||
          suspendedText.includes('This account has been suspended')) {
        data.isSuspended = true;
        this._cacheAndNotify(username, data);
        return;
      }

      // Find the profile header area
      const primaryColumn = document.querySelector('[data-testid="primaryColumn"]');
      if (!primaryColumn) {
        XFlagLogger.log('[ProfileScraper] No primary column found');
        return;
      }

      // Look for "Account based in" text - this is in the About section
      // The format is typically a row with icon + "Account based in" + country name
      const aboutSection = this._findAboutSection(primaryColumn);

      if (aboutSection) {
        // Parse the about section for location data
        const locationData = this._parseAboutSection(aboutSection);
        if (locationData.basedIn) {
          data.basedIn = locationData.basedIn;
        }
        if (locationData.connectedVia) {
          data.connectedVia = locationData.connectedVia;
        }
        if (locationData.hasVpnWarning) {
          data.hasVpnWarning = true;
        }
      }

      // Find join date - look for "Joined Month Year" pattern
      const joinedInfo = this._findJoinedDate(primaryColumn);
      if (joinedInfo) {
        data.joinedYear = joinedInfo.year;
        data.joinedMonth = joinedInfo.month;
      }

      // Check for protected account (lock icon)
      const protectedIcon = primaryColumn.querySelector('[data-testid="icon-lock"]');
      if (protectedIcon) {
        data.isProtected = true;
      }
      // Also check for protected text
      if (document.body.innerText.includes('These Tweets are protected')) {
        data.isProtected = true;
      }

      // Check for verified badge
      const verifiedBadge = primaryColumn.querySelector('[data-testid="icon-verified"]') ||
                           primaryColumn.querySelector('[aria-label="Verified account"]') ||
                           primaryColumn.querySelector('svg[aria-label*="Verified"]');
      if (verifiedBadge) {
        data.isVerified = true;
      }

      // Get display name
      const displayNameEl = primaryColumn.querySelector('[data-testid="UserName"]');
      if (displayNameEl) {
        const nameSpan = displayNameEl.querySelector('span');
        if (nameSpan) {
          data.displayName = nameSpan.textContent?.trim();
        }
      }

      XFlagLogger.log('[ProfileScraper] Scraped data:', JSON.stringify(data));

      // Check if we already have better data cached
      const existing = this.scrapedProfiles.get(username);
      if (existing) {
        // Merge: keep existing data if new scrape doesn't have it
        if (existing.basedIn && !data.basedIn) {
          data.basedIn = existing.basedIn;
          XFlagLogger.log('[ProfileScraper] Preserved existing basedIn:', existing.basedIn);
        }
        if (existing.connectedVia && !data.connectedVia) {
          data.connectedVia = existing.connectedVia;
        }
        if (existing.hasVpnWarning && !data.hasVpnWarning) {
          data.hasVpnWarning = existing.hasVpnWarning;
        }
        if (existing.joinedYear && !data.joinedYear) {
          data.joinedYear = existing.joinedYear;
          data.joinedMonth = existing.joinedMonth;
        }
      }

      // Cache and notify background
      this._cacheAndNotify(username, data);

    } catch (error) {
      console.error('[ProfileScraper] Error scraping:', error);
    }
  },

  /**
   * Find the About section on the profile page
   */
  _findAboutSection(container) {
    // The about info might be on the main profile page or /about subpage
    // Look for sections containing location/country info

    // Method 1: Look for text containing "Account based in" or "Connected via"
    const allText = container.innerText;

    if (allText.includes('Account based in') || allText.includes('Connected via')) {
      // Found it - return the container for parsing
      return container;
    }

    // Method 2: Look for the location icon row
    // X uses icons followed by text for profile metadata
    const locationRows = container.querySelectorAll('[data-testid="UserProfileHeader_Items"] > *');

    return container;
  },

  /**
   * Parse the about section for location data
   */
  _parseAboutSection(section) {
    const result = {
      basedIn: null,
      connectedVia: null,
      hasVpnWarning: false
    };

    const text = section.innerText;
    XFlagLogger.log('[ProfileScraper] Parsing section text length:', text.length);

    // Method 1: Use regex to find patterns in the full text
    // "Account based in" followed by location on next line or same line
    const basedInMatch = text.match(/Account based in\s*\n?\s*([A-Za-z\s]+?)(?:\n|$)/i);
    if (basedInMatch && basedInMatch[1]) {
      const location = basedInMatch[1].trim();
      if (location && location.length > 0 && location.length < 50) {
        result.basedIn = {
          country: location,
          raw: location
        };
        XFlagLogger.log('[ProfileScraper] Found basedIn via regex:', location);
      }
    }

    // "Connected via" followed by app/region info
    const connectedViaMatch = text.match(/Connected via\s*\n?\s*([A-Za-z\s]+(?:App|Store)?)/i);
    if (connectedViaMatch && connectedViaMatch[1]) {
      const connection = connectedViaMatch[1].trim();
      if (connection && connection.length > 0) {
        // Extract the region part (e.g., "Europe" from "Europe Android App")
        const regionMatch = connection.match(/^([A-Za-z\s]+?)(?:\s+(?:Android|iOS|Web|App))/i);
        const region = regionMatch ? regionMatch[1].trim() : connection;
        result.connectedVia = {
          country: region,
          raw: connection
        };
        XFlagLogger.log('[ProfileScraper] Found connectedVia via regex:', connection);
      }
    }

    // Method 2: Line by line parsing as fallback
    if (!result.basedIn || !result.connectedVia) {
      const lines = text.split('\n').map(l => l.trim()).filter(l => l);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // "Account based in" followed by country name
        if (!result.basedIn && (line === 'Account based in' || line.includes('Account based in'))) {
          const nextLine = lines[i + 1];
          if (nextLine && !nextLine.includes('Connected via') && !nextLine.includes('Joined') && !nextLine.includes('Verified')) {
            result.basedIn = {
              country: nextLine,
              raw: nextLine
            };
            XFlagLogger.log('[ProfileScraper] Found basedIn via lines:', nextLine);
          }
        }

        // "Connected via" followed by country/region
        if (!result.connectedVia && (line === 'Connected via' || line.includes('Connected via'))) {
          const nextLine = lines[i + 1];
          if (nextLine && !nextLine.includes('Account based') && !nextLine.includes('Joined') && !nextLine.includes('username')) {
            const regionMatch = nextLine.match(/^([A-Za-z\s]+?)(?:\s+(?:Android|iOS|Web|App))/i);
            const region = regionMatch ? regionMatch[1].trim() : nextLine;
            result.connectedVia = {
              country: region,
              raw: nextLine
            };
            XFlagLogger.log('[ProfileScraper] Found connectedVia via lines:', nextLine);
          }
        }
      }
    }

    // Check for the info icon indicating VPN/mismatch warning (ⓘ circle-i icon)
    // This appears near "Account based in" when there's a location mismatch
    if (text.includes('ⓘ') || section.querySelector('[aria-label*="information"]') || section.querySelector('[data-testid*="info"]')) {
      result.hasVpnWarning = true;
      XFlagLogger.log('[ProfileScraper] Found VPN warning indicator');
    }

    return result;
  },

  /**
   * Find the join date from profile
   */
  _findJoinedDate(container) {
    const text = container.innerText;

    // Pattern: "Joined Month Year" (e.g., "Joined March 2009")
    const joinedMatch = text.match(/Joined\s+([A-Za-z]+)\s+(\d{4})/i);

    if (joinedMatch) {
      return {
        month: joinedMatch[1],
        year: parseInt(joinedMatch[2], 10)
      };
    }

    // Also try to find in specific elements
    const dateElements = container.querySelectorAll('[data-testid="UserProfileHeader_Items"] span');
    for (const el of dateElements) {
      const elText = el.textContent?.trim();
      if (elText) {
        const match = elText.match(/Joined\s+([A-Za-z]+)\s+(\d{4})/i);
        if (match) {
          return {
            month: match[1],
            year: parseInt(match[2], 10)
          };
        }
      }
    }

    return null;
  },

  /**
   * Cache the scraped data and notify background script
   */
  async _cacheAndNotify(username, data) {
    // Store locally
    this.scrapedProfiles.set(username, data);

    // Send to background script for caching
    try {
      await chrome.runtime.sendMessage({
        type: 'SCRAPED_PROFILE_DATA',
        username: username,
        data: data
      });
      XFlagLogger.log('[ProfileScraper] Sent data to background');
    } catch (error) {
      // Extension context invalidated - happens when extension is reloaded
      if (error.message?.includes('Extension context invalidated')) {
        XFlagLogger.log('[ProfileScraper] Extension reloaded - refresh page to reconnect');
      } else {
        console.error('[ProfileScraper] Failed to send to background:', error);
      }
    }
  },

  /**
   * Get scraped data for a username (if available)
   */
  getScrapedData(username) {
    return this.scrapedProfiles.get(username.toLowerCase()) || null;
  }
};

// Make available globally
if (typeof window !== 'undefined') {
  window.ProfileScraper = ProfileScraper;
}
