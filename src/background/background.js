/**
 * Background Service Worker
 * Handles message passing, caching, and profile fetching
 */

// Chrome runs this file as a service worker and needs importScripts(). Firefox
// runs it as an event page and loads the dependencies from manifest.json.
if (typeof importScripts === 'function') {
  importScripts(
    '../shared/constants.js',
    '../shared/countries.js',
    '../shared/message-types.js',
    'cache-manager.js',
    'profile-fetcher.js'
  );
}

// Initialize managers
const cacheManager = new CacheManager();
const profileFetcher = new ProfileFetcher(cacheManager);

// Settings storage key
const SETTINGS_KEY = 'extensionSettings';

const DEFAULT_SETTINGS = { ...CONSTANTS.DISPLAY_DEFAULTS };

const X_TAB_PATTERNS = ['https://x.com/*', 'https://twitter.com/*'];

/**
 * Keep only known boolean settings (protects against malformed imports).
 */
function sanitizeSettings(settings) {
  const clean = {};
  if (!settings || typeof settings !== 'object') return clean;

  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (typeof settings[key] === 'boolean') {
      clean[key] = settings[key];
    }
  }
  return clean;
}

/**
 * Get current settings
 */
async function getSettings() {
  try {
    const data = await chrome.storage.local.get(SETTINGS_KEY);
    const settings = { ...DEFAULT_SETTINGS, ...sanitizeSettings(data[SETTINGS_KEY]) };
    XFlagLogger.setEnabled(settings.debugMode);
    return settings;
  } catch (error) {
    console.error('[Background] Error getting settings:', error);
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Send a message to every open X tab.
 */
async function broadcastToTabs(message) {
  const tabs = await chrome.tabs.query({ url: X_TAB_PATTERNS });
  await Promise.all(tabs.map(tab =>
    chrome.tabs.sendMessage(tab.id, message).catch(() => {
      // Tab might not have content script loaded
    })
  ));
}

/**
 * Update settings
 */
async function updateSettings(newSettings) {
  const current = await getSettings();
  const updated = { ...current, ...sanitizeSettings(newSettings) };
  await chrome.storage.local.set({ [SETTINGS_KEY]: updated });
  XFlagLogger.setEnabled(updated.debugMode);

  await broadcastToTabs({
    type: MESSAGE_TYPES.SETTINGS_UPDATED,
    settings: updated
  });

  return updated;
}

function isValidUsername(username) {
  return typeof username === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(username);
}

/**
 * Handle messages from content scripts and popup
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only accept messages from this extension's own pages and content scripts.
  if (sender.id !== chrome.runtime.id || !message || typeof message !== 'object') {
    return false;
  }

  const handleAsync = async () => {
    try {
      switch (message.type) {
        case MESSAGE_TYPES.FETCH_PROFILE: {
          if (!isValidUsername(message.username)) {
            return { error: 'Invalid username' };
          }
          try {
            const data = await profileFetcher.fetchProfile(message.username, message.csrfToken);
            return { data };
          } catch (error) {
            if (error.rateLimited) {
              return { rateLimited: true, resetAt: error.resetAt };
            }
            if (error.authFailed) {
              // Not under `error`, so the content script can tell it apart
              return { authFailed: true, message: error.message };
            }
            throw error;
          }
        }

        case MESSAGE_TYPES.GET_CACHED_PROFILES: {
          const usernames = Array.isArray(message.usernames)
            ? message.usernames.filter(isValidUsername).slice(0, 500)
            : [];
          const data = await cacheManager.getMultiple(usernames.map(u => u.toLowerCase()));
          return { data };
        }

        case MESSAGE_TYPES.CACHE_PROFILE: {
          // Profile data scraped from the DOM by the content script
          const { username, data } = message;
          if (!isValidUsername(username) || !data || typeof data !== 'object') {
            return { error: 'Invalid profile data' };
          }
          XFlagLogger.log('[Background] Received scraped data for:', username, data);
          // A profile header alone (join date, name) must not create an
          // entry: that would replace the hover placeholder with a year-only
          // badge and the flag could never be loaded for that user.
          const createIfMissing = Boolean(data.basedIn || data.connectedVia || data.isSuspended);
          const entry = await cacheManager.merge(username.toLowerCase(), data, {
            createIfMissing,
            // Suspensions get lifted; don't remember one for a month
            ttl: data.isSuspended === true ? cacheManager.UNAVAILABLE_TTL : null
          });
          return { data: entry };
        }

        case MESSAGE_TYPES.CLEAR_CACHE: {
          await cacheManager.clear();
          await broadcastToTabs({ type: MESSAGE_TYPES.CACHE_CLEARED });
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
          const importData = message.data;
          if (!importData || typeof importData !== 'object') {
            return { error: 'Invalid import data' };
          }

          let imported = 0;
          if (importData.cache) {
            imported = await cacheManager.import(importData.cache);
          }
          if (importData.settings) {
            await updateSettings(importData.settings);
          }
          return { imported };
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
