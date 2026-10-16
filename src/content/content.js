/**
 * Content Script - Main entry point
 * Orchestrates username finding, badge injection, and profile fetching
 */

(function() {
  'use strict';

  // State
  let settings = { ...CONSTANTS.DISPLAY_DEFAULTS };
  let initialized = false;
  let stopped = false;

  // username -> cache entry (including negative "no data" entries)
  const profiles = new Map();

  // Usernames already looked up in the background cache
  const checkedUsernames = new Set();

  // Usernames waiting for a batched cache lookup
  const pendingLookups = new Set();
  let lookupTimer = null;

  // username -> Promise for in-progress network fetches
  const activeFetches = new Map();

  // Delay before a hover triggers a network request, so sweeping the mouse
  // across the timeline doesn't fire a burst of lookups.
  const HOVER_INTENT_MS = 250;
  // Lookups queue up one per second in the background, so a burst of hovers
  // can legitimately take a while.
  const FETCH_TIMEOUT_MS = 120000;
  const MESSAGE_TIMEOUT_MS = 10000;

  /**
   * Whether this content script still belongs to a live extension instance.
   * After an update or reload, the old script keeps running in open tabs.
   */
  function hasExtensionContext() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  /**
   * Stop all work once the extension context is gone.
   */
  function shutdown() {
    if (stopped) return;
    stopped = true;
    DOMObserver.stop();
    urlObserver.disconnect();
    XFlagLogger.log('[XFlag] Extension was reloaded - refresh the page to reconnect');
  }

  /**
   * Send message to background, failing after a timeout
   * @param {Object} message - Message to send
   * @param {number} timeoutMs - How long to wait for a response
   * @returns {Promise<Object>} Response from background
   */
  async function sendMessage(message, timeoutMs = MESSAGE_TIMEOUT_MS) {
    if (!hasExtensionContext()) {
      shutdown();
      throw new Error('Extension context invalidated');
    }

    let timer;
    try {
      const response = await Promise.race([
        chrome.runtime.sendMessage(message),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Timeout')), timeoutMs);
        })
      ]);

      if (!response) {
        throw new Error('Background service did not respond');
      }
      if (response.error) {
        throw new Error(response.error);
      }

      return response;
    } catch (error) {
      if (/Extension context (was )?invalidated/i.test(error.message || '')) {
        shutdown();
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Get the ct0 CSRF token from cookies
   */
  function getCsrfToken() {
    const match = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/);
    return match ? match[1] : null;
  }

  function hasDisplayData(entry) {
    return Boolean(entry && !entry.isNegative &&
      (entry.basedIn || entry.joinedYear || entry.connectedVia || entry.isSuspended));
  }

  /**
   * Initialize the extension
   */
  async function init() {
    if (initialized) return;
    initialized = true;

    XFlagLogger.log('[XFlag] Initializing content script...');

    try {
      try {
        const response = await sendMessage({ type: MESSAGE_TYPES.GET_SETTINGS });
        if (response.settings) {
          settings = response.settings;
          XFlagLogger.setEnabled(settings.debugMode);
        }
      } catch (error) {
        XFlagLogger.log('[XFlag] Could not load settings, using defaults:', error.message);
      }

      // The extension was reloaded before we got going; this copy of the
      // script can't talk to the background any more.
      if (stopped) return;

      BadgeInjector.init(settings);

      // Firefox injects an updated extension's content scripts into tabs
      // that are already open. Badges left by the previous copy have dead
      // event listeners, so start from a clean page.
      BadgeInjector.removeAll();
      UsernameFinder.clearProcessed();

      DOMObserver.init(handleNewUsernames);
      ProfileScraper.init(handleScrapedProfile);
      chrome.runtime.onMessage.addListener(handleMessage);

      DOMObserver.start();
      urlObserver.observe(document.body, { childList: true, subtree: true });

      XFlagLogger.log('[XFlag] Content script initialized successfully');
    } catch (error) {
      console.error('[XFlag] Initialization error:', error);
    }
  }

  /**
   * Handle messages from background script
   */
  function handleMessage(message) {
    if (message?.type === MESSAGE_TYPES.SETTINGS_UPDATED && message.settings) {
      settings = message.settings;
      XFlagLogger.setEnabled(settings.debugMode);
      BadgeInjector.updateSettings(settings);
      renderAll();
    } else if (message?.type === MESSAGE_TYPES.CACHE_CLEARED) {
      profiles.clear();
      checkedUsernames.clear();
      renderAll();
    }

    return false;
  }

  /**
   * Handle new username elements found by the observer.
   * Shows known data immediately; otherwise shows a placeholder and checks
   * the background cache in one batched request.
   */
  function handleNewUsernames(usernameItems) {
    if (!usernameItems || usernameItems.length === 0) return;

    for (const item of usernameItems) {
      const username = item.username.toLowerCase();
      UsernameFinder.markProcessed(item.element, username);
      renderElement(item.element, username);

      if (!profiles.has(username) && !checkedUsernames.has(username)) {
        pendingLookups.add(username);
      }
    }

    scheduleCacheLookup();
  }

  function scheduleCacheLookup() {
    if (lookupTimer || pendingLookups.size === 0) return;

    lookupTimer = setTimeout(async () => {
      lookupTimer = null;
      const usernames = [...pendingLookups].slice(0, 200);
      usernames.forEach(username => {
        pendingLookups.delete(username);
        checkedUsernames.add(username);
      });

      try {
        const response = await sendMessage({
          type: MESSAGE_TYPES.GET_CACHED_PROFILES,
          usernames
        });

        for (const [username, entry] of Object.entries(response.data || {})) {
          if (entry && !profiles.has(username)) {
            profiles.set(username, entry);
            renderUser(username);
          }
        }
      } catch (error) {
        // Allow another attempt next time these users appear
        usernames.forEach(username => checkedUsernames.delete(username));
        XFlagLogger.log('[XFlag] Cache lookup failed:', error.message);
      }

      scheduleCacheLookup();
    }, 50);
  }

  /**
   * Store profile data sent back from a profile page visit.
   */
  async function handleScrapedProfile(username, data) {
    try {
      const response = await sendMessage({
        type: MESSAGE_TYPES.CACHE_PROFILE,
        username,
        data
      });
      if (response.data) {
        profiles.set(username, response.data);
        renderUser(username);
      }
    } catch (error) {
      XFlagLogger.log('[XFlag] Could not cache scraped profile:', error.message);
    }
  }

  /**
   * All username elements on the page for one user
   */
  function elementsFor(username) {
    // Usernames are validated to [a-z0-9_], so they are safe in a selector.
    return document.querySelectorAll(`[${CONSTANTS.DATA_ATTRS.USERNAME}="${username}"]`);
  }

  function renderUser(username) {
    for (const element of elementsFor(username)) {
      renderElement(element, username);
    }
  }

  function renderAll() {
    const processed = document.querySelectorAll(`[${CONSTANTS.DATA_ATTRS.USERNAME}]`);
    for (const element of processed) {
      renderElement(element, element.getAttribute(CONSTANTS.DATA_ATTRS.USERNAME));
    }
  }

  /**
   * Show the right badge for a username element based on what we know.
   */
  function renderElement(element, username) {
    if (!element.isConnected) return;

    const entry = profiles.get(username);

    if (hasDisplayData(entry)) {
      BadgeInjector.update(element, entry);
    } else if (entry) {
      BadgeInjector.inject(element, createStatusBadge('—', 'No location data available', 'x-flag-no-data'));
    } else if (activeFetches.has(username)) {
      BadgeInjector.inject(element, createLoadingBadge());
    } else {
      BadgeInjector.inject(element, createHoverPlaceholder(username));
    }
  }

  function createLoadingBadge() {
    const container = document.createElement('span');
    container.className = `${CONSTANTS.CSS_CLASSES.BADGE_CONTAINER} ${CONSTANTS.CSS_CLASSES.LOADING}`;
    container.setAttribute('aria-busy', 'true');
    const spinner = document.createElement('span');
    spinner.className = 'x-flag-spinner';
    container.appendChild(spinner);
    return container;
  }

  function createStatusBadge(text, title, className) {
    const container = document.createElement('span');
    container.className = CONSTANTS.CSS_CLASSES.BADGE_CONTAINER;
    const span = document.createElement('span');
    span.className = className;
    span.title = title;
    span.setAttribute('aria-label', title);
    span.textContent = text;
    container.appendChild(span);
    return container;
  }

  /**
   * Create a placeholder that loads profile data on hover, click or Enter.
   */
  function createHoverPlaceholder(username, state = {}) {
    const container = document.createElement('span');
    container.className = `${CONSTANTS.CSS_CLASSES.BADGE_CONTAINER} x-flag-placeholder`;
    container.setAttribute('role', 'button');
    container.setAttribute('tabindex', '0');

    const icon = document.createElement('span');
    icon.className = state.className || 'x-flag-hover-icon';
    icon.textContent = state.icon || '🌐';
    container.title = state.title || `Hover or click to load country info for @${username}`;
    container.setAttribute('aria-label', container.title);
    container.appendChild(icon);

    let hoverTimer = null;

    const load = () => {
      clearTimeout(hoverTimer);
      // The hover timer can fire after React or a re-render removed us
      if (!container.isConnected) return;
      loadProfile(username);
    };

    container.addEventListener('mouseenter', () => {
      hoverTimer = setTimeout(load, HOVER_INTENT_MS);
    });
    container.addEventListener('mouseleave', () => clearTimeout(hoverTimer));

    // Don't let the click open the tweet or profile underneath.
    container.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      load();
    });
    container.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        event.stopPropagation();
        load();
      }
    });

    return container;
  }

  /**
   * Fetch a profile through the background script and update every badge
   * for that user on the page.
   */
  function loadProfile(username) {
    if (profiles.has(username)) {
      // Already known (e.g. a stale placeholder was clicked): just redraw
      renderUser(username);
      return undefined;
    }
    if (activeFetches.has(username)) {
      return activeFetches.get(username);
    }

    const fetchPromise = (async () => {
      const csrfToken = getCsrfToken();
      if (!csrfToken) {
        throw new Error('Sign in to X to load country info');
      }

      const response = await sendMessage({
        type: MESSAGE_TYPES.FETCH_PROFILE,
        username,
        csrfToken
      }, FETCH_TIMEOUT_MS);

      if (response.rateLimited) {
        return { rateLimited: true, resetAt: response.resetAt };
      }
      if (response.authFailed) {
        throw new Error(response.message || 'Sign in to X to load country info');
      }
      return { data: response.data };
    })();

    activeFetches.set(username, fetchPromise);
    renderUser(username);

    fetchPromise
      .then(result => {
        activeFetches.delete(username);

        // Data may have arrived another way meanwhile (e.g. the user opened
        // this profile); don't replace it with a status placeholder.
        if (profiles.has(username)) {
          renderUser(username);
          return;
        }

        if (result.rateLimited) {
          const until = result.resetAt
            ? new Date(result.resetAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : 'a few minutes';
          showPlaceholderState(username, {
            icon: '⏳',
            className: 'x-flag-rate-limited',
            title: `X rate limit reached - try again after ${until}`
          });
          return;
        }

        const data = result.data;
        if (!data || !(data.fetchedAt || hasDisplayData(data))) {
          // Nothing usable came back and nothing was cached (e.g. X returned
          // an error), so leave the placeholder retryable.
          throw new Error("Couldn't load country info");
        }
        profiles.set(username, data);
        renderUser(username);
      })
      .catch(error => {
        activeFetches.delete(username);
        XFlagLogger.log('[XFlag] Fetch error:', error.message);

        if (profiles.has(username)) {
          renderUser(username);
          return;
        }

        if (stopped) {
          // Don't leave a spinner behind after the extension was reloaded
          showPlaceholderState(username, {
            icon: '⚠️',
            className: CONSTANTS.CSS_CLASSES.ERROR,
            title: 'X Flags was updated - refresh the page to reconnect'
          });
          return;
        }

        showPlaceholderState(username, {
          icon: '⚠️',
          className: CONSTANTS.CSS_CLASSES.ERROR,
          title: `${error.message === 'Timeout' ? 'Request timed out' : error.message} - click to retry`
        });
      });

    return fetchPromise;
  }

  function showPlaceholderState(username, state) {
    for (const element of elementsFor(username)) {
      if (element.isConnected) {
        BadgeInjector.inject(element, createHoverPlaceholder(username, state));
      }
    }
  }

  /**
   * Check if we're on a supported page
   */
  function isSupportedPage() {
    const host = window.location.host;
    return host === 'x.com' || host === 'twitter.com' ||
           host.endsWith('.x.com') || host.endsWith('.twitter.com');
  }

  // Handle navigation (X uses client-side routing)
  let lastUrl = location.href;
  const urlObserver = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      XFlagLogger.log('[XFlag] URL changed, rescanning...');
      DOMObserver.scan();
      ProfileScraper.onNavigate();
    }
  });

  // Start initialization when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      if (isSupportedPage()) init();
    });
  } else if (isSupportedPage()) {
    init();
  }

})();
