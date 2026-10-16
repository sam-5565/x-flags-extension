/**
 * Profile Scraper - Extracts profile data from the rendered DOM
 * Works by scraping data when user visits a profile page
 */

const ProfileScraper = {
  // Called with (username, data) after a successful scrape
  onScraped: null,

  // Pending scrape timer
  scrapeTimer: null,

  // Initialization state
  initialized: false,

  // How long to wait for X to render a profile, and how often to retry
  SCRAPE_DELAY_MS: 1500,
  SCRAPE_ATTEMPTS: 3,

  /**
   * Initialize the scraper
   * @param {Function} onScraped - Receives (username, data)
   */
  init(onScraped) {
    XFlagLogger.log('[ProfileScraper] Initializing...');
    this.onScraped = onScraped;
    this.initialized = true;
    this.onNavigate();
  },

  /**
   * Call when the page URL changes (X uses client-side routing)
   */
  onNavigate() {
    if (this.scrapeTimer) {
      clearTimeout(this.scrapeTimer);
      this.scrapeTimer = null;
    }

    const username = this._getProfileUsername();
    if (!username) return;

    XFlagLogger.log(`[ProfileScraper] On profile page for: ${username}`);
    this._scheduleScrape(username, 1);
  },

  /**
   * Username for the profile page currently shown, or null
   */
  _getProfileUsername() {
    // Match /{username} or /{username}/about patterns
    const profileMatch = window.location.pathname.match(/^\/([A-Za-z0-9_]{1,15})(\/about)?\/?$/);
    if (!profileMatch) return null;

    const username = profileMatch[1].toLowerCase();
    return CONSTANTS.RESERVED_PATHS.includes(username) ? null : username;
  },

  _scheduleScrape(username, attempt) {
    this.scrapeTimer = setTimeout(() => {
      this.scrapeTimer = null;

      // The user may have navigated away while we were waiting.
      if (this._getProfileUsername() !== username) return;

      const scraped = this._scrapeProfileData(username);
      if (scraped) {
        this._notify(username, scraped);
      } else if (attempt < this.SCRAPE_ATTEMPTS) {
        this._scheduleScrape(username, attempt + 1);
      }
    }, this.SCRAPE_DELAY_MS);
  },

  /**
   * Scrape profile data from the current page
   * @returns {Object|null} Scraped data, or null if the profile isn't rendered yet
   */
  _scrapeProfileData(username) {
    const primaryColumn = document.querySelector(CONSTANTS.SELECTORS.TIMELINE);
    if (!primaryColumn) {
      XFlagLogger.log('[ProfileScraper] No primary column found');
      return null;
    }

    const data = {
      username: username,
      basedIn: null,
      connectedVia: null,
      joinedYear: null,
      joinedMonth: null,
      isProtected: false,
      isVerified: false,
      isSuspended: false,
      displayName: null
    };

    try {
      // Suspended profiles show an empty state instead of a header
      const emptyStates = primaryColumn.querySelectorAll('[data-testid="emptyState"]');
      for (const emptyState of emptyStates) {
        if (/account suspended/i.test(emptyState.textContent || '')) {
          data.isSuspended = true;
          return data;
        }
      }

      // Only trust the header if it belongs to the profile in the URL.
      const header = this._findProfileHeader(primaryColumn, username);

      if (header) {
        const nameSpan = header.querySelector('span');
        if (nameSpan) {
          data.displayName = nameSpan.textContent?.trim() || null;
        }

        if (header.querySelector(CONSTANTS.PROFILE_SELECTORS.PROTECTED_ICON)) {
          data.isProtected = true;
        }

        if (header.querySelector(CONSTANTS.PROFILE_SELECTORS.VERIFIED_BADGE) ||
            header.querySelector('svg[aria-label*="Verified"]')) {
          data.isVerified = true;
        }

        const joinedInfo = this._findJoinedDate(primaryColumn);
        if (joinedInfo) {
          data.joinedYear = joinedInfo.year;
          data.joinedMonth = joinedInfo.month;
        }
      }

      // "About this account" page: "Account based in" / "Connected via"
      const locationData = this._parseAboutSection(primaryColumn);
      if (locationData.basedIn) data.basedIn = locationData.basedIn;
      if (locationData.connectedVia) data.connectedVia = locationData.connectedVia;

      if (!header && !data.basedIn && !data.connectedVia) {
        return null;
      }

      XFlagLogger.log('[ProfileScraper] Scraped data:', JSON.stringify(data));
      return data;

    } catch (error) {
      console.error('[ProfileScraper] Error scraping:', error);
      return null;
    }
  },

  /**
   * Find the profile header showing @username
   */
  _findProfileHeader(container, username) {
    const header = container.querySelector(CONSTANTS.SELECTORS.PROFILE_HEADER);
    if (!header) return null;

    const handle = `@${username}`;
    for (const span of header.querySelectorAll('span')) {
      if (span.textContent?.trim().toLowerCase() === handle) {
        return header;
      }
    }
    return null;
  },

  /**
   * Parse the About section for location data
   */
  _parseAboutSection(section) {
    const result = {
      basedIn: null,
      connectedVia: null
    };

    const text = section.innerText || '';
    if (!/Account based in|Connected via/i.test(text)) {
      return result;
    }

    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const labels = /^(Account based in|Connected via|Joined|Verified|Date joined|Username)/i;

    const valueAfter = (label) => {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.toLowerCase().startsWith(label)) continue;

        // Value on the same line ("Account based in United States")...
        const sameLine = line.slice(label.length).trim();
        if (sameLine) return sameLine;

        // ...or on the next line
        const nextLine = lines[i + 1];
        if (nextLine && !labels.test(nextLine) && nextLine.length < 60) {
          return nextLine;
        }
      }
      return null;
    };

    const basedIn = valueAfter('account based in');
    if (basedIn) {
      result.basedIn = { country: basedIn, raw: basedIn };
      XFlagLogger.log('[ProfileScraper] Found basedIn:', basedIn);
    }

    const connectedVia = valueAfter('connected via');
    if (connectedVia) {
      result.connectedVia = {
        country: normalizeCountryName(connectedVia),
        raw: connectedVia
      };
      XFlagLogger.log('[ProfileScraper] Found connectedVia:', connectedVia);
    }

    return result;
  },

  /**
   * Find the join date from profile
   */
  _findJoinedDate(container) {
    const joinDate = container.querySelector(CONSTANTS.PROFILE_SELECTORS.JOIN_DATE);
    const text = joinDate?.textContent?.trim();
    if (!text) return null;

    // English: "Joined March 2009"
    const joinedMatch = text.match(/Joined\s+([A-Za-z]+)\s+(\d{4})/i);
    if (joinedMatch) {
      return {
        month: joinedMatch[1].slice(0, 3),
        year: parseInt(joinedMatch[2], 10)
      };
    }

    // Other UI languages: at least get the year
    const yearMatch = text.match(/\b(20\d{2}|19\d{2})\b/);
    if (yearMatch) {
      return { month: null, year: parseInt(yearMatch[1], 10) };
    }

    return null;
  },

  /**
   * Hand scraped data to the content script
   */
  _notify(username, data) {
    if (this.onScraped) {
      this.onScraped(username, data);
    }
  }
};

// Make available globally
if (typeof window !== 'undefined') {
  window.ProfileScraper = ProfileScraper;
}
