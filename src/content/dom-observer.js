/**
 * DOM Observer - Watches for new content and triggers processing
 */

const DOMObserver = {
  // Observer instance
  observer: null,

  // Debounce timer
  debounceTimer: null,

  // Scroll tracking
  isScrolling: false,
  scrollTimer: null,
  scrollHandler: null,

  // Whether a processing pass is already scheduled
  processScheduled: false,

  // Callback for when new usernames are found
  onNewUsernames: null,

  /**
   * Initialize the observer
   * @param {Function} callback - Called with array of new username elements
   */
  init(callback) {
    this.onNewUsernames = callback;
    this._setupMutationObserver();
    this._setupScrollTracking();

    XFlagLogger.log('[DOMObserver] Initialized');
  },

  /**
   * Start observing
   */
  start() {
    if (!this.observer) {
      this._setupMutationObserver();
    }

    // Observe the whole body: X swaps out <main> when navigating between
    // some pages, and modals/hovercards render outside it.
    this.observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    XFlagLogger.log('[DOMObserver] Started observing');

    // Process initial content
    this._processNewContent();
  },

  /**
   * Stop observing
   */
  stop() {
    if (this.observer) {
      this.observer.disconnect();
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    if (this.scrollTimer) {
      clearTimeout(this.scrollTimer);
    }

    if (this.scrollHandler) {
      window.removeEventListener('scroll', this.scrollHandler);
      this.scrollHandler = null;
    }

    XFlagLogger.log('[DOMObserver] Stopped observing');
  },

  /**
   * Manually trigger a scan for new usernames
   */
  scan() {
    this._processNewContent();
  },

  /**
   * Setup mutation observer
   */
  _setupMutationObserver() {
    this.observer = new MutationObserver(() => {
      // Debounce rapid mutations
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }

      this.debounceTimer = setTimeout(() => {
        // Skip processing during rapid scroll; the scroll handler rescans
        // once scrolling settles.
        if (this.isScrolling) {
          return;
        }

        this._processNewContent();
      }, CONSTANTS.OBSERVER.DEBOUNCE_MS);
    });
  },

  /**
   * Setup scroll tracking to pause during rapid scrolling
   */
  _setupScrollTracking() {
    if (this.scrollHandler) return;

    let lastScrollY = window.scrollY;

    this.scrollHandler = () => {
      const currentScrollY = window.scrollY;
      const scrollDelta = Math.abs(currentScrollY - lastScrollY);

      // Detect rapid scrolling
      if (scrollDelta > 100) {
        this.isScrolling = true;

        if (this.scrollTimer) {
          clearTimeout(this.scrollTimer);
        }

        this.scrollTimer = setTimeout(() => {
          this.isScrolling = false;
          // Process content after scroll settles
          this._processNewContent();
        }, CONSTANTS.OBSERVER.SCROLL_PAUSE_MS);
      }

      lastScrollY = currentScrollY;
    };

    // Use passive listener for better scroll performance
    window.addEventListener('scroll', this.scrollHandler, { passive: true });
  },

  /**
   * Schedule a processing pass for new content
   */
  _processNewContent() {
    if (this.processScheduled) return;
    this.processScheduled = true;

    const run = () => {
      this.processScheduled = false;
      this._doProcess();
    };

    // Use requestIdleCallback if available for non-critical updates
    if (window.requestIdleCallback) {
      window.requestIdleCallback(run, { timeout: 1000 });
    } else {
      setTimeout(run, 0);
    }
  },

  /**
   * Actually do the processing
   */
  _doProcess() {
    const newElements = UsernameFinder.findNew();

    if (newElements.length === 0) {
      return;
    }

    XFlagLogger.log(`[DOMObserver] Found ${newElements.length} new username elements`);

    if (this.onNewUsernames) {
      this.onNewUsernames(newElements);
    }
  }
};

// Make available globally
if (typeof window !== 'undefined') {
  window.DOMObserver = DOMObserver;
}
