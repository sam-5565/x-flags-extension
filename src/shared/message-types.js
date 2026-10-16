/**
 * Message types for communication between content script and background service worker
 */

const MESSAGE_TYPES = {
  // Profile lookups (content script passes the page's CSRF token)
  FETCH_PROFILE: 'FETCH_PROFILE_WITH_AUTH',

  // Cache operations
  GET_CACHED_PROFILES: 'GET_CACHED_PROFILES',
  CACHE_PROFILE: 'SCRAPED_PROFILE_DATA',
  CLEAR_CACHE: 'CLEAR_CACHE',
  CACHE_CLEARED: 'CACHE_CLEARED',
  GET_CACHE_STATS: 'GET_CACHE_STATS',

  // Settings
  GET_SETTINGS: 'GET_SETTINGS',
  UPDATE_SETTINGS: 'UPDATE_SETTINGS',
  SETTINGS_UPDATED: 'SETTINGS_UPDATED',

  // Status
  GET_STATUS: 'GET_STATUS',

  // Export/Import
  EXPORT_DATA: 'EXPORT_DATA',
  IMPORT_DATA: 'IMPORT_DATA'
};

// Make available globally
if (typeof window !== 'undefined') {
  window.MESSAGE_TYPES = MESSAGE_TYPES;
}
