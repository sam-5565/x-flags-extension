/**
 * Constants used throughout the extension
 */

const CONSTANTS = {
  // Cache settings - aggressive caching to minimize API calls
  CACHE: {
    DEFAULT_TTL: 30 * 24 * 60 * 60 * 1000,     // 30 days
    VERIFIED_TTL: 90 * 24 * 60 * 60 * 1000,    // 90 days
    NEGATIVE_TTL: 7 * 24 * 60 * 60 * 1000,     // 7 days for failed lookups
    MAX_ENTRIES: 50000,                         // 50k entries
    STORAGE_KEY: 'profileCache'
  },

  // Rate limiting
  RATE_LIMIT: {
    MIN_DELAY: 500,                             // Min ms between requests
    MAX_DELAY: 30000,                           // Max backoff delay
    BACKOFF_MULTIPLIER: 2,
    MAX_CONCURRENT: 3,                          // Max concurrent fetches
    QUEUE_PROCESS_INTERVAL: 100                 // Ms between queue checks
  },

  // DOM observation
  OBSERVER: {
    DEBOUNCE_MS: 100,                           // Debounce mutations
    SCROLL_PAUSE_MS: 150,                       // Pause during rapid scroll
    INTERSECTION_THRESHOLD: 0.1                 // Visibility threshold
  },

  // DOM selectors for X.com (may need updates if X changes their markup)
  SELECTORS: {
    // Username links in tweets and profiles
    USERNAME_LINK: 'a[href^="/"][role="link"]',
    // Tweet container
    TWEET: 'article[data-testid="tweet"]',
    // User cell in lists
    USER_CELL: '[data-testid="UserCell"]',
    // Timeline container
    TIMELINE: '[data-testid="primaryColumn"]',
    // Profile header
    PROFILE_HEADER: '[data-testid="UserName"]',
    // The main scrollable area
    SCROLL_CONTAINER: 'main'
  },

  // Profile page selectors for scraping
  PROFILE_SELECTORS: {
    // Location info spans
    ACCOUNT_INFO: '[data-testid="UserProfileHeader_Items"]',
    // Join date
    JOIN_DATE: '[data-testid="UserJoinDate"]',
    // Protected account indicator
    PROTECTED_ICON: '[data-testid="icon-lock"]',
    // Verified badge
    VERIFIED_BADGE: '[data-testid="icon-verified"]'
  },

  // Display settings defaults
  DISPLAY_DEFAULTS: {
    showBasedIn: true,
    showConnectedVia: true,
    showVpnWarning: true,
    showYear: true,
    showMismatchHighlight: true,
    showProtectedIcon: true,
    debugMode: false
  },

  // Badge class names
  CSS_CLASSES: {
    BADGE_CONTAINER: 'x-flag-badge-container',
    FLAG: 'x-flag-emoji',
    WARNING: 'x-flag-warning',
    YEAR: 'x-flag-year',
    PROTECTED: 'x-flag-protected',
    MISMATCH: 'x-flag-mismatch',
    LOADING: 'x-flag-loading',
    ERROR: 'x-flag-error',
    TOOLTIP: 'x-flag-tooltip',
    PROCESSED: 'x-flag-processed'
  },

  // Data attributes
  DATA_ATTRS: {
    USERNAME: 'data-x-flag-username',
    PROCESSED: 'data-x-flag-processed',
    TIMESTAMP: 'data-x-flag-ts'
  }
};

/**
 * Verbose logging shared by content scripts and the background worker.
 * Errors and warnings still use the console directly; profile/API details are
 * only logged when Debug Mode is enabled.
 */
const XFlagLogger = {
  enabled: false,

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
  },

  log(...args) {
    if (this.enabled) {
      console.log(...args);
    }
  }
};

// Make available globally for content scripts
if (typeof window !== 'undefined') {
  window.CONSTANTS = CONSTANTS;
  window.XFlagLogger = XFlagLogger;
}

// Make available to the background service worker.
if (typeof self !== 'undefined') {
  self.XFlagLogger = XFlagLogger;
}
