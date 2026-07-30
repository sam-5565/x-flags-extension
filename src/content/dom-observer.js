/**
 * DOM Observer - Watches for new content and triggers processing
 */

const DOMObserver = {
  // Observer instance
  observer: null,

  // Intersection observer for visibility
  intersectionObserver: null,

  // Debounce timer
  debounceTimer: null,

  // Scroll tracking
  isScrolling: false,
  scrollTimer: null,

  // Callback for when new usernames are found
  onNewUsernames: null,

  // Queue of elements to process
  pendingElements: new Set(),

  // Visible elements
  visibleElements: new Set(),

  /**
   * Initialize the observer
   * @param {Function} callback - Called with array of new username elements
   */
  init(callback) {
    this.onNewUsernames = callback;
    this._setupMutationObserver();
    this._setupIntersectionObserver();
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

    // Observe the main content area
    const mainContent = document.querySelector('main') || document.body;

    this.observer.observe(mainContent, {
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

    if (this.intersectionObserver) {
      this.intersectionObserver.disconnect();
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    if (this.scrollTimer) {
      clearTimeout(this.scrollTimer);
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
    this.observer = new MutationObserver((mutations) => {
      // Debounce rapid mutations
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }

      this.debounceTimer = setTimeout(() => {
        // Skip processing during rapid scroll
        if (this.isScrolling) {
          return;
        }

        this._processNewContent();
      }, CONSTANTS.OBSERVER.DEBOUNCE_MS);
    });
  },

  /**
   * Setup intersection observer for visibility tracking
   */
  _setupIntersectionObserver() {
    this.intersectionObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            this.visibleElements.add(entry.target);
          } else {
            this.visibleElements.delete(entry.target);
          }
        }

        // Process visible elements with priority
        this._processVisibleElements();
      },
      {
        threshold: CONSTANTS.OBSERVER.INTERSECTION_THRESHOLD,
        rootMargin: '100px' // Pre-fetch slightly before visible
      }
    );
  },

  /**
   * Setup scroll tracking to pause during rapid scrolling
   */
  _setupScrollTracking() {
    let lastScrollY = window.scrollY;

    const scrollHandler = () => {
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
    window.addEventListener('scroll', scrollHandler, { passive: true });
  },

  /**
   * Process new content for usernames
   */
  _processNewContent() {
    // Use requestIdleCallback if available for non-critical updates
    if (window.requestIdleCallback) {
      window.requestIdleCallback(() => this._doProcess(), { timeout: 1000 });
    } else {
      setTimeout(() => this._doProcess(), 0);
    }
  },

  /**
   * Actually do the processing
   */
  _doProcess() {
    // Find new username elements
    const newElements = UsernameFinder.findNew();

    if (newElements.length === 0) {
      return;
    }

    XFlagLogger.log(`[DOMObserver] Found ${newElements.length} new username elements`);

    // Add to pending and observe for visibility
    for (const item of newElements) {
      this.pendingElements.add(item);

      // Track visibility
      if (this.intersectionObserver) {
        this.intersectionObserver.observe(item.element);
      }
    }

    // Process visible elements first
    this._processVisibleElements();

    // Then process remaining elements
    this._processRemainingElements();
  },

  /**
   * Process visible elements with priority
   */
  _processVisibleElements() {
    const visibleItems = [];

    for (const item of this.pendingElements) {
      if (this.visibleElements.has(item.element)) {
        visibleItems.push(item);
        this.pendingElements.delete(item);
      }
    }

    if (visibleItems.length > 0 && this.onNewUsernames) {
      this.onNewUsernames(visibleItems, true); // true = high priority
    }
  },

  /**
   * Process remaining (non-visible) elements
   */
  _processRemainingElements() {
    const remainingItems = Array.from(this.pendingElements);
    this.pendingElements.clear();

    if (remainingItems.length > 0 && this.onNewUsernames) {
      this.onNewUsernames(remainingItems, false); // false = normal priority
    }
  },

  /**
   * Clear all pending elements
   */
  clearPending() {
    this.pendingElements.clear();
    this.visibleElements.clear();
  }
};

// Make available globally
if (typeof window !== 'undefined') {
  window.DOMObserver = DOMObserver;
}
