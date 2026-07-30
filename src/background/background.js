/**
 * Background Service Worker
 * Handles message passing, caching, and profile fetching
 */

// Import dependencies
importScripts(
  '../shared/constants.js',
  '../shared/countries.js',
  '../shared/message-types.js',
  'cache-manager.js',
  'profile-fetcher.js'
);

// Initialize managers
const cacheManager = new CacheManager();
const profileFetcher = new ProfileFetcher(cacheManager);

// Settings storage key
const SETTINGS_KEY = 'extensionSettings';

// Rate limiting for background fetches
let lastFetchTime = 0;
const MIN_FETCH_DELAY = 1000; // 1 second between fetches

/**
 * Fetch profile using X's GraphQL API with provided CSRF token
 * Makes two API calls: UserByScreenName (for join date) and AboutAccountQuery (for location)
 */
async function fetchProfileWithAuth(username, csrfToken) {
  // Rate limiting
  const now = Date.now();
  const timeSinceLastFetch = now - lastFetchTime;
  if (timeSinceLastFetch < MIN_FETCH_DELAY) {
    await new Promise(resolve => setTimeout(resolve, MIN_FETCH_DELAY - timeSinceLastFetch));
  }
  lastFetchTime = Date.now();

  const headers = {
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Content-Type': 'application/json',
    'X-Twitter-Active-User': 'yes',
    'X-Twitter-Client-Language': 'en',
    'X-Csrf-Token': csrfToken,
    'Authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA'
  };

  // Combined data from both endpoints
  let combinedData = {
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

  // 1. Fetch UserByScreenName for join date and basic info
  try {
    const userVariables = JSON.stringify({
      screen_name: username,
      withSafetyModeUserFields: true
    });
    const userFeatures = JSON.stringify({
      hidden_profile_subscriptions_enabled: true,
      rweb_tipjar_consumption_enabled: true,
      responsive_web_graphql_exclude_directive_enabled: true,
      verified_phone_label_enabled: false,
      subscriptions_verification_info_is_identity_verified_enabled: true,
      subscriptions_verification_info_verified_since_enabled: true,
      highlights_tweets_tab_ui_enabled: true,
      responsive_web_twitter_article_notes_tab_enabled: true,
      subscriptions_feature_can_gift_premium: true,
      creator_subscriptions_tweet_preview_api_enabled: true,
      responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
      responsive_web_graphql_timeline_navigation_enabled: true
    });

    const userQueryId = 'xmU6X_CKVnQ5lSrCbAmJsg';
    const userUrl = `https://x.com/i/api/graphql/${userQueryId}/UserByScreenName?variables=${encodeURIComponent(userVariables)}&features=${encodeURIComponent(userFeatures)}`;

    XFlagLogger.log('[Background] Fetching UserByScreenName for:', username);
    const userResponse = await fetch(userUrl, { credentials: 'include', headers });

    if (userResponse.ok) {
      const userJson = await userResponse.json();
      const userData = parseUserByScreenName(userJson, username);
      if (userData) {
        combinedData = { ...combinedData, ...userData };
      }
    } else if (userResponse.status === 429) {
      console.warn('[Background] Rate limited on UserByScreenName');
    }
  } catch (error) {
    console.error('[Background] UserByScreenName error:', error);
  }

  // Small delay between calls
  await new Promise(resolve => setTimeout(resolve, 300));

  // 2. Fetch AboutAccountQuery for location info
  try {
    const aboutVariables = JSON.stringify({ screenName: username });
    const aboutQueryId = 'zs_jFPFT78rBpXv9Z3U2YQ';
    const aboutUrl = `https://x.com/i/api/graphql/${aboutQueryId}/AboutAccountQuery?variables=${encodeURIComponent(aboutVariables)}`;

    XFlagLogger.log('[Background] Fetching AboutAccountQuery for:', username);
    const aboutResponse = await fetch(aboutUrl, { credentials: 'include', headers });

    if (aboutResponse.ok) {
      const aboutJson = await aboutResponse.json();
      const aboutData = parseAboutAccountResponse(aboutJson, username);
      if (aboutData) {
        // Merge - prefer aboutData for location fields
        if (aboutData.basedIn) combinedData.basedIn = aboutData.basedIn;
        if (aboutData.connectedVia) combinedData.connectedVia = aboutData.connectedVia;
        if (aboutData.hasVpnWarning) combinedData.hasVpnWarning = aboutData.hasVpnWarning;
      }
    } else if (aboutResponse.status === 429) {
      console.warn('[Background] Rate limited on AboutAccountQuery');
    }
  } catch (error) {
    console.error('[Background] AboutAccountQuery error:', error);
  }

  XFlagLogger.log('[Background] Combined data for', username, ':', combinedData);

  // Return null if we got nothing useful
  if (!combinedData.basedIn && !combinedData.joinedYear && !combinedData.connectedVia) {
    return null;
  }

  return combinedData;
}

/**
 * Parse UserByScreenName response for join date
 */
function parseUserByScreenName(json, username) {
  try {
    const userResult = json?.data?.user?.result;
    if (!userResult) return null;

    if (userResult.__typename === 'UserUnavailable') {
      return { isSuspended: true };
    }

    const legacy = userResult.legacy;
    if (!legacy) return null;

    const data = {};

    // Join date from created_at: "Tue Mar 15 00:00:00 +0000 2022"
    if (legacy.created_at) {
      const yearMatch = legacy.created_at.match(/(\d{4})$/);
      if (yearMatch) {
        data.joinedYear = parseInt(yearMatch[1], 10);
      }
      const monthMatch = legacy.created_at.match(/^[A-Za-z]{3} ([A-Za-z]{3})/);
      if (monthMatch) {
        data.joinedMonth = monthMatch[1];
      }
      XFlagLogger.log('[Background] Found join date:', data.joinedMonth, data.joinedYear);
    }

    if (legacy.name) data.displayName = legacy.name;
    if (legacy.protected) data.isProtected = true;
    if (legacy.verified) data.isVerified = true;
    if (userResult.is_blue_verified) data.isVerified = true;

    return data;
  } catch (error) {
    console.error('[Background] UserByScreenName parse error:', error);
    return null;
  }
}

/**
 * Parse AboutAccountQuery response
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
    const userResult = json?.data?.user_result_by_screen_name?.result;
    if (!userResult) return null;

    if (userResult.__typename === 'UserUnavailable') {
      data.isSuspended = true;
      return data;
    }

    const aboutProfile = userResult.about_profile;
    if (aboutProfile) {
      if (aboutProfile.account_based_in) {
        data.basedIn = {
          country: aboutProfile.account_based_in,
          raw: aboutProfile.account_based_in
        };
      }

      if (aboutProfile.source) {
        const source = aboutProfile.source;
        const regionMatch = source.match(/^([A-Za-z\s]+?)(?:\s+(?:Android|iOS|Web|App|Store|iPhone|iPad))/i);
        const region = regionMatch ? regionMatch[1].trim() : source;
        data.connectedVia = {
          country: region,
          raw: source
        };
      }

      if (aboutProfile.location_accurate === false) {
        data.hasVpnWarning = true;
      }
    }

    const legacy = userResult.legacy;
    if (legacy) {
      if (legacy.created_at) {
        const match = legacy.created_at.match(/(\d{4})$/);
        if (match) data.joinedYear = parseInt(match[1], 10);
        const monthMatch = legacy.created_at.match(/^[A-Za-z]{3} ([A-Za-z]{3})/);
        if (monthMatch) data.joinedMonth = monthMatch[1];
      }
      if (legacy.name) data.displayName = legacy.name;
      if (legacy.protected) data.isProtected = true;
      if (legacy.verified) data.isVerified = true;
    }

    if (userResult.is_blue_verified) data.isVerified = true;

    XFlagLogger.log('[Background] Parsed data:', username, data);
    return data;

  } catch (error) {
    console.error('[Background] Parse error:', error);
    return null;
  }
}

// Default settings
const DEFAULT_SETTINGS = {
  showBasedIn: true,
  showConnectedVia: true,
  showVpnWarning: true,
  showYear: true,
  showMismatchHighlight: true,
  showProtectedIcon: true,
  debugMode: false
};

/**
 * Get current settings
 */
async function getSettings() {
  try {
    const data = await chrome.storage.local.get(SETTINGS_KEY);
    const settings = { ...DEFAULT_SETTINGS, ...data[SETTINGS_KEY] };
    XFlagLogger.setEnabled(settings.debugMode);
    return settings;
  } catch (error) {
    console.error('[Background] Error getting settings:', error);
    return DEFAULT_SETTINGS;
  }
}

/**
 * Update settings
 */
async function updateSettings(newSettings) {
  try {
    const current = await getSettings();
    const updated = { ...current, ...newSettings };
    await chrome.storage.local.set({ [SETTINGS_KEY]: updated });
    XFlagLogger.setEnabled(updated.debugMode);

    // Notify all tabs of settings change
    const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
    for (const tab of tabs) {
      try {
        await chrome.tabs.sendMessage(tab.id, {
          type: MESSAGE_TYPES.SETTINGS_UPDATED,
          settings: updated
        });
      } catch (e) {
        // Tab might not have content script loaded
      }
    }

    return updated;
  } catch (error) {
    console.error('[Background] Error updating settings:', error);
    throw error;
  }
}

/**
 * Handle messages from content scripts and popup
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Handle async responses
  const handleAsync = async () => {
    try {
      switch (message.type) {
        case MESSAGE_TYPES.FETCH_PROFILE: {
          const data = await profileFetcher.fetchProfile(message.username);
          return { type: MESSAGE_TYPES.FETCH_PROFILE_RESULT, data };
        }

        case MESSAGE_TYPES.FETCH_PROFILES_BATCH: {
          const data = await profileFetcher.fetchProfiles(message.usernames);
          return { type: MESSAGE_TYPES.FETCH_PROFILES_BATCH_RESULT, data };
        }

        case MESSAGE_TYPES.GET_CACHED_PROFILE: {
          const data = await cacheManager.get(message.username);
          return { data };
        }

        case MESSAGE_TYPES.GET_CACHED_PROFILES: {
          const data = await cacheManager.getMultiple(message.usernames);
          return { data };
        }

        case MESSAGE_TYPES.CLEAR_CACHE: {
          await cacheManager.clear();
          return { success: true };
        }

        case MESSAGE_TYPES.GET_CACHE_STATS: {
          const stats = await cacheManager.getStats();
          return { stats };
        }

        case MESSAGE_TYPES.GET_SETTINGS: {
          const settings = await getSettings();
          return { settings };
        }

        case MESSAGE_TYPES.UPDATE_SETTINGS: {
          const settings = await updateSettings(message.settings);
          return { settings };
        }

        case MESSAGE_TYPES.GET_STATUS: {
          const fetcherStatus = profileFetcher.getStatus();
          const cacheStats = await cacheManager.getStats();
          return {
            fetcher: fetcherStatus,
            cache: cacheStats
          };
        }

        case MESSAGE_TYPES.EXPORT_DATA: {
          const exportData = await cacheManager.export();
          const settings = await getSettings();
          return {
            cache: exportData,
            settings: settings
          };
        }

        case MESSAGE_TYPES.IMPORT_DATA: {
          let imported = 0;
          if (message.data.cache) {
            imported = await cacheManager.import(message.data.cache);
          }
          if (message.data.settings) {
            await updateSettings(message.data.settings);
          }
          return { imported };
        }

        case 'SCRAPED_PROFILE_DATA': {
          // Handle profile data scraped from the DOM by content script
          const { username, data } = message;
          XFlagLogger.log('[Background] Received scraped data for:', username, data);

          if (username && data) {
            const isVerified = data.isVerified || false;
            await cacheManager.set(username.toLowerCase(), data, isVerified, false);
            XFlagLogger.log('[Background] Cached scraped data for:', username);
          }
          return { success: true };
        }

        case 'GET_ALL_CACHED_PROFILES': {
          // Return all cached profiles to content script
          await cacheManager.init();
          const allProfiles = {};
          for (const [username, entry] of cacheManager.memoryCache.entries()) {
            if (entry && !entry.isNegative &&
                (entry.joinedYear || entry.basedIn || entry.connectedVia)) {
              allProfiles[username] = entry;
            }
          }
          XFlagLogger.log('[Background] Returning', Object.keys(allProfiles).length, 'cached profiles');
          return { data: allProfiles };
        }

        case 'FETCH_PROFILE_WITH_AUTH': {
          // Fetch profile using CSRF token passed from content script
          const { username, csrfToken } = message;
          XFlagLogger.log('[Background] Fetching profile with auth:', username);

          try {
            const data = await fetchProfileWithAuth(username, csrfToken);
            if (data) {
              // Cache it
              const isVerified = data.isVerified || false;
              await cacheManager.set(username.toLowerCase(), data, isVerified, false);
            }
            return { data };
          } catch (error) {
            console.error('[Background] Fetch error:', error);
            return { error: error.message };
          }
        }

        default:
          console.warn('[Background] Unknown message type:', message.type);
          return { error: 'Unknown message type' };
      }
    } catch (error) {
      console.error('[Background] Error handling message:', error);
      return { error: error.message };
    }
  };

  // Execute async handler and send response
  handleAsync().then(sendResponse);

  // Return true to indicate async response
  return true;
});

/**
 * Handle extension install/update
 */
chrome.runtime.onInstalled.addListener(async (details) => {
  XFlagLogger.log('[Background] Extension installed/updated:', details.reason);

  // Initialize cache
  await cacheManager.init();

  // Set default settings if first install
  if (details.reason === 'install') {
    await chrome.storage.local.set({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
    XFlagLogger.log('[Background] Default settings initialized');
  }
});

/**
 * Handle extension startup
 */
chrome.runtime.onStartup.addListener(async () => {
  XFlagLogger.log('[Background] Extension started');
  await cacheManager.init();
});

// Log service worker activation
XFlagLogger.log('[Background] Service worker loaded');

// Apply the persisted Debug Mode setting when the worker starts.
getSettings();
