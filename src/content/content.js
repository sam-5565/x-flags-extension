/**
 * Content Script - Main entry point
 * Orchestrates username finding, badge injection, and profile fetching
 */

(function() {
  'use strict';

  // State
  let settings = null;
  let initialized = false;

  // Fetch mode: 'hover' = only fetch on hover, 'auto' = fetch visible automatically
  const FETCH_MODE = 'hover';

  // Rate limiting
  const MIN_API_DELAY = 1500; // 1.5 seconds between API calls (can be faster with hover mode)
  let lastApiCall = 0;
  let rateLimitedUntil = 0;

  // Track elements waiting for hover
  const pendingHoverElements = new Map(); // element -> {username, hasListener}

  /**
   * Send message to background with retry on context invalidation
   * @param {Object} message - Message to send
   * @param {number} maxRetries - Max retry attempts
   * @returns {Promise<Object>} Response from background
   */
  async function sendMessageWithRetry(message, maxRetries = 2) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await Promise.race([
          chrome.runtime.sendMessage(message),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Timeout')), 10000)
          )
        ]);

        if (!response) {
          throw new Error('Background service did not respond');
        }
        if (response.error) {
          throw new Error(response.error);
        }

        return response;
      } catch (error) {
        const isInvalidContext = error.message?.includes('Extension context invalidated') ||
                                  error.message?.includes('Extension context was invalidated');

        if (isInvalidContext && attempt < maxRetries) {
          XFlagLogger.log('[XFlag] Extension context invalidated, retrying...');
          // Small delay before retry
          await new Promise(resolve => setTimeout(resolve, 100));
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * Get the ct0 CSRF token from cookies
   */
  function getCsrfToken() {
    const match = document.cookie.match(/ct0=([^;]+)/);
    return match ? match[1] : null;
  }


  /**
   * Wait for rate limit
   * Returns false if we should skip the API call entirely
   */
  async function waitForRateLimit() {
    const now = Date.now();

    // If we're in a rate-limited state from X, skip API calls
    if (now < rateLimitedUntil) {
      const waitMins = Math.ceil((rateLimitedUntil - now) / 60000);
      XFlagLogger.log(`[XFlag] Rate limited by X, ${waitMins} minutes remaining`);
      return false;
    }

    // Ensure minimum delay between calls
    const timeSinceLastCall = now - lastApiCall;
    if (timeSinceLastCall < MIN_API_DELAY) {
      await new Promise(resolve => setTimeout(resolve, MIN_API_DELAY - timeSinceLastCall));
    }

    lastApiCall = Date.now();
    return true;
  }

  /**
   * Handle rate limit response from X
   * @param {Response} response - The fetch response
   */
  function handleRateLimitResponse(response) {
    // Check for rate limit reset header
    const resetTime = response.headers.get('x-rate-limit-reset');
    if (resetTime) {
      // Reset time is in Unix epoch seconds
      rateLimitedUntil = parseInt(resetTime, 10) * 1000;
      const waitMins = Math.ceil((rateLimitedUntil - Date.now()) / 60000);
      XFlagLogger.log(`[XFlag] Rate limited by X, will reset in ${waitMins} minutes`);
    } else {
      // If no header, back off for 5 minutes
      rateLimitedUntil = Date.now() + (5 * 60 * 1000);
      XFlagLogger.log(`[XFlag] Rate limited by X, backing off for 5 minutes`);
    }
  }

  /**
   * Fetch profile data via X's AboutAccountQuery GraphQL API
   * Called from content script to use page's authentication cookies
   */
  async function fetchAboutAccount(username) {
    try {
      // Apply rate limiting - returns false if we should skip
      const canProceed = await waitForRateLimit();
      if (!canProceed) {
        return null;
      }

      const variables = JSON.stringify({ screenName: username });
      // Query ID from X's own requests - this may change periodically
      const queryId = 'zs_jFPFT78rBpXv9Z3U2YQ';
      const url = `https://x.com/i/api/graphql/${queryId}/AboutAccountQuery?variables=${encodeURIComponent(variables)}`;

      // Get CSRF token from cookie
      const csrfToken = getCsrfToken();
      if (!csrfToken) {
        XFlagLogger.log(`[XFlag] No CSRF token found, cannot fetch API`);
        return null;
      }

      XFlagLogger.log(`[XFlag] Fetching AboutAccountQuery for ${username}`);

      const response = await fetch(url, {
        credentials: 'include',
        headers: {
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Content-Type': 'application/json',
          'X-Twitter-Active-User': 'yes',
          'X-Twitter-Client-Language': 'en',
          'X-Csrf-Token': csrfToken,
          'Authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA'
        }
      });

      // Handle rate limiting from X
      if (response.status === 429) {
        XFlagLogger.log(`[XFlag] Got 429 rate limited for ${username}`);
        handleRateLimitResponse(response);
        return null;
      }

      if (!response.ok) {
        XFlagLogger.log(`[XFlag] AboutAccountQuery failed for ${username}: ${response.status}`);
        return null;
      }

      const json = await response.json();
      XFlagLogger.log(`[XFlag] AboutAccountQuery response for ${username}:`, JSON.stringify(json).substring(0, 300));

      return parseAboutAccountResponse(json, username);

    } catch (error) {
      console.error(`[XFlag] AboutAccountQuery error for ${username}:`, error);
      return null;
    }
  }

  /**
   * Parse AboutAccountQuery GraphQL response
   */
  function parseAboutAccountResponse(json, username) {
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
      // Log full response structure for debugging
      XFlagLogger.log(`[XFlag] Full API response for ${username}:`, JSON.stringify(json, null, 2).substring(0, 2000));

      const userResult = json?.data?.user_result_by_screen_name?.result;

      if (!userResult) {
        XFlagLogger.log(`[XFlag] No user data in response for ${username}. Data keys:`, json?.data ? Object.keys(json.data) : 'no data');
        return null;
      }

      XFlagLogger.log(`[XFlag] userResult keys for ${username}:`, Object.keys(userResult));

      if (userResult.__typename === 'UserUnavailable') {
        data.isSuspended = true;
        return data;
      }

      const aboutProfile = userResult.about_profile;

      XFlagLogger.log(`[XFlag] about_profile for ${username}:`, aboutProfile ? JSON.stringify(aboutProfile) : 'null');

      if (aboutProfile) {
        // "Account based in"
        if (aboutProfile.account_based_in) {
          data.basedIn = {
            country: aboutProfile.account_based_in,
            raw: aboutProfile.account_based_in
          };
          XFlagLogger.log(`[XFlag] Found basedIn: ${aboutProfile.account_based_in}`);
        }

        // "Connected via" - field is called "source" in the API
        if (aboutProfile.source) {
          const source = aboutProfile.source;
          // Parse region from "Europe Android App" or "US iOS App" -> extract region
          const regionMatch = source.match(/^([A-Za-z\s]+?)(?:\s+(?:Android|iOS|Web|App|Store|iPhone|iPad))/i);
          const region = regionMatch ? regionMatch[1].trim() : source;

          data.connectedVia = {
            country: region,
            raw: source
          };
          XFlagLogger.log(`[XFlag] Found connectedVia (source): ${source}`);
        }

        // VPN warning - field is "location_accurate" (false means VPN detected)
        if (aboutProfile.location_accurate === false) {
          data.hasVpnWarning = true;
          XFlagLogger.log(`[XFlag] Found VPN warning (location_accurate: false)`);
        }

        // Join date from description or other fields
        if (aboutProfile.description) {
          const joinMatch = aboutProfile.description.match(/Joined\s+([A-Za-z]+)\s+(\d{4})/i);
          if (joinMatch) {
            data.joinedMonth = joinMatch[1];
            data.joinedYear = parseInt(joinMatch[2], 10);
            XFlagLogger.log(`[XFlag] Found joined from description: ${data.joinedMonth} ${data.joinedYear}`);
          }
        }
      }

      // Legacy data fallback
      const legacy = userResult.legacy;
      if (legacy) {
        if (!data.joinedYear && legacy.created_at) {
          // Format: "Tue Mar 15 00:00:00 +0000 2022"
          const match = legacy.created_at.match(/(\d{4})$/);
          if (match) {
            data.joinedYear = parseInt(match[1], 10);
          }
          const monthMatch = legacy.created_at.match(/^[A-Za-z]{3} ([A-Za-z]{3})/);
          if (monthMatch) {
            data.joinedMonth = monthMatch[1];
          }
          XFlagLogger.log(`[XFlag] Found joined from legacy.created_at: ${data.joinedMonth} ${data.joinedYear}`);
        }
        if (legacy.name) data.displayName = legacy.name;
        if (legacy.protected) data.isProtected = true;
        if (legacy.verified) data.isVerified = true;
      }

      if (userResult.is_blue_verified) data.isVerified = true;

      // Log all available fields for debugging
      XFlagLogger.log(`[XFlag] aboutProfile fields:`, aboutProfile ? Object.keys(aboutProfile) : 'none');
      XFlagLogger.log(`[XFlag] legacy fields:`, legacy ? Object.keys(legacy) : 'none');
      XFlagLogger.log(`[XFlag] Parsed data for ${username}:`, JSON.stringify(data));
      return data;

    } catch (error) {
      console.error(`[XFlag] Parse error for ${username}:`, error);
      return null;
    }
  }

  /**
   * Initialize the extension
   */
  async function init() {
    if (initialized) return;

    XFlagLogger.log('[XFlag] Initializing content script...');

    try {
      // Use default settings initially, load from background async
      settings = CONSTANTS.DISPLAY_DEFAULTS;
      XFlagLogger.log('[XFlag] Using default settings');

      // Try to load settings from background (non-blocking)
      chrome.runtime.sendMessage({ type: MESSAGE_TYPES.GET_SETTINGS })
        .then(response => {
          if (response && response.settings) {
            settings = response.settings;
            XFlagLogger.setEnabled(settings.debugMode);
            BadgeInjector.updateSettings(settings);
            XFlagLogger.log('[XFlag] Loaded settings from background');
          }
        })
        .catch(err => XFlagLogger.log('[XFlag] Could not load settings:', err));

      // Initialize badge injector with settings
      BadgeInjector.init(settings);
      XFlagLogger.log('[XFlag] Badge injector initialized');

      // Initialize DOM observer with callback
      DOMObserver.init(handleNewUsernames);
      XFlagLogger.log('[XFlag] DOM observer initialized');

      // Initialize profile scraper (scrapes data when visiting profile pages)
      // This loads cached profiles from background into memory
      await ProfileScraper.init();
      XFlagLogger.log('[XFlag] Profile scraper initialized');

      // Start observing
      DOMObserver.start();
      XFlagLogger.log('[XFlag] DOM observer started');

      // Listen for settings updates
      chrome.runtime.onMessage.addListener(handleMessage);

      initialized = true;
      XFlagLogger.log('[XFlag] Content script initialized successfully');

      // Debug: manually scan after a short delay to catch initial content
      setTimeout(() => {
        XFlagLogger.log('[XFlag] Running initial scan...');
        const found = UsernameFinder.findAll();
        XFlagLogger.log('[XFlag] Found usernames:', found.length, found.map(f => f.username));
        if (found.length > 0) {
          handleNewUsernames(found, true);
        }
      }, 2000);

    } catch (error) {
      console.error('[XFlag] Initialization error:', error);
    }
  }

  /**
   * Handle messages from background script
   */
  function handleMessage(message, sender, sendResponse) {
    if (message.type === MESSAGE_TYPES.SETTINGS_UPDATED) {
      settings = message.settings;
      XFlagLogger.setEnabled(settings.debugMode);
      BadgeInjector.updateSettings(settings);

      // Refresh all badges with new settings
      refreshAllBadges();
    }

    return false;
  }

  /**
   * Handle new username elements found by the observer
   * In hover mode: show placeholder, fetch on hover
   * Shows cached data immediately if available
   */
  function handleNewUsernames(usernameItems, highPriority) {
    if (!usernameItems || usernameItems.length === 0) return;

    for (const item of usernameItems) {
      UsernameFinder.markProcessed(item.element, item.username);
      const username = item.username.toLowerCase();

      // Check cache first - show immediately if we have data
      const cached = ProfileScraper.getScrapedData(username);
      if (cached && (cached.basedIn || cached.joinedYear || cached.connectedVia)) {
        const badge = BadgeInjector.createBadge(cached);
        if (badge) {
          BadgeInjector.inject(item.element, badge);
        }
        continue;
      }

      // No cached data - show hover placeholder
      const placeholder = createHoverPlaceholder(item.element, username);
      BadgeInjector.inject(item.element, placeholder);
    }
  }

  /**
   * Create a hover placeholder that fetches data on hover
   * Uses background script for fetching to avoid rate limit issues on main page
   */
  function createHoverPlaceholder(element, username) {
    const container = document.createElement('span');
    container.className = CONSTANTS.CSS_CLASSES.BADGE_CONTAINER;
    container.innerHTML = '<span class="x-flag-hover-icon" title="Hover to load country info">🌐</span>';
    container.style.cursor = 'pointer';
    container.style.opacity = '0.5';

    let fetching = false;

    const fetchOnHover = async () => {
      if (fetching) return;
      fetching = true;

      // Show loading
      container.innerHTML = '<span class="x-flag-spinner"></span>';
      container.style.opacity = '1';

      try {
        // Get CSRF token and send to background for fetching
        const csrfToken = getCsrfToken();
        if (!csrfToken) {
          throw new Error('No CSRF token');
        }

        // Request background script to fetch
        const response = await sendMessageWithRetry({
          type: 'FETCH_PROFILE_WITH_AUTH',
          username: username,
          csrfToken: csrfToken
        });

        const data = response?.data;

        if (data && (data.basedIn || data.joinedYear || data.connectedVia)) {
          // Update local cache
          ProfileScraper.scrapedProfiles.set(username, data);

          // Replace with real badge
          const badge = BadgeInjector.createBadge(data);
          if (badge && element.isConnected) {
            BadgeInjector.inject(element, badge);
          } else {
            BadgeInjector.remove(element);
          }
          container.removeEventListener('mouseenter', fetchOnHover);
        } else {
          // No data available - show dash
          container.innerHTML = '<span class="x-flag-no-data" title="No location data available">—</span>';
          container.style.opacity = '0.4';
          container.removeEventListener('mouseenter', fetchOnHover);
        }
      } catch (error) {
        console.error('[XFlag] Hover fetch error:', error);
        container.innerHTML = '<span class="x-flag-error" title="Failed to load">⚠️</span>';
        container.style.opacity = '0.5';
        fetching = false; // Allow retry
      }
    };

    container.addEventListener('mouseenter', fetchOnHover);

    return container;
  }


  /**
   * Refresh all badges with current settings
   */
  async function refreshAllBadges() {
    // Find all processed elements
    const processedElements = document.querySelectorAll(
      `[${CONSTANTS.DATA_ATTRS.PROCESSED}]`
    );

    const items = [];

    for (const element of processedElements) {
      // Find the badge container
      const badge = BadgeInjector.get(element);

      if (badge) {
        // Get username from nearby link or stored attribute
        const username = element.getAttribute(CONSTANTS.DATA_ATTRS.USERNAME) ||
                         extractUsernameFromElement(element);

        if (username) {
          items.push({ element, username });
        }
      }
    }

    if (items.length === 0) return;

    // Re-fetch and re-render all badges
    const usernames = [...new Set(items.map(i => i.username.toLowerCase()))];

    try {
      const response = await sendMessageWithRetry({
        type: MESSAGE_TYPES.GET_CACHED_PROFILES,
        usernames: usernames
      });

      const cached = response.data || {};

      for (const item of items) {
        const profileData = cached[item.username.toLowerCase()];
        if (profileData && !profileData.isNegative) {
          BadgeInjector.update(item.element, profileData);
        } else {
          const placeholder = createHoverPlaceholder(
            item.element,
            item.username.toLowerCase()
          );
          BadgeInjector.inject(item.element, placeholder);
        }
      }

    } catch (error) {
      console.error('[XFlag] Error refreshing badges:', error);
    }
  }

  /**
   * Extract username from an element
   */
  function extractUsernameFromElement(element) {
    // Try href attribute
    const href = element.getAttribute('href');
    if (href) {
      const match = href.match(/^\/([A-Za-z0-9_]{1,15})(?:$|\/|\?)/);
      if (match) return match[1];
    }

    // Try text content
    const text = element.textContent?.trim();
    if (text && text.startsWith('@')) {
      return text.substring(1);
    }

    return null;
  }

  /**
   * Check if we're on a supported page
   */
  function isSupportedPage() {
    const host = window.location.host;
    return host === 'x.com' || host === 'twitter.com' ||
           host.endsWith('.x.com') || host.endsWith('.twitter.com');
  }

  // Start initialization when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      if (isSupportedPage()) init();
    });
  } else {
    if (isSupportedPage()) init();
  }

  // Also handle navigation (X uses client-side routing)
  let lastUrl = location.href;
  const urlObserver = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      XFlagLogger.log('[XFlag] URL changed, rescanning...');
      DOMObserver.scan();
    }
  });

  urlObserver.observe(document.body, { childList: true, subtree: true });

})();
