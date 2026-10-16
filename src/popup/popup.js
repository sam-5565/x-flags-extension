/**
 * Popup Script - Settings UI and cache management
 */

// MESSAGE_TYPES comes from ../shared/message-types.js

// Firefox closes extension popups when a file picker opens, so importing has
// to happen from the same page opened in a regular tab.
const IS_FIREFOX = typeof browser !== 'undefined' && navigator.userAgent.includes('Firefox');
const IS_TAB = new URLSearchParams(location.search).has('tab');

// Setting IDs that map to checkboxes
const SETTING_IDS = [
  'showBasedIn',
  'showConnectedVia',
  'showVpnWarning',
  'showYear',
  'showMismatchHighlight',
  'showProtectedIcon',
  'debugMode'
];

/**
 * Initialize popup
 */
async function init() {
  document.getElementById('extensionVersion').textContent =
    `v${chrome.runtime.getManifest().version}`;

  // Load current settings
  await loadSettings();

  // Load cache stats
  await loadCacheStats();

  // Setup event listeners
  setupEventListeners();

  if (IS_TAB) {
    document.body.classList.add('in-tab');
  }

  await checkSiteAccess();
}

const SITE_ORIGINS = ['https://x.com/*', 'https://twitter.com/*'];

/**
 * Firefox lets users revoke a Manifest V3 extension's site access at any
 * time; without it neither the content script nor the lookups work. Show a
 * notice with a button to grant it back.
 */
async function checkSiteAccess() {
  const notice = document.getElementById('accessNotice');
  if (!notice || !chrome.permissions?.contains) return;

  try {
    const granted = await chrome.permissions.contains({ origins: SITE_ORIGINS });
    notice.hidden = granted;
  } catch (error) {
    notice.hidden = true;
  }
}

async function handleGrantAccess() {
  try {
    const granted = await chrome.permissions.request({ origins: SITE_ORIGINS });
    if (granted) {
      document.getElementById('accessNotice').hidden = true;
      showToast('Access to x.com granted - reload your X tabs', 'success');
    }
  } catch (error) {
    console.error('Error requesting site access:', error);
    showToast('Could not request site access', 'error');
  }
}

/**
 * Send a message and surface background-handler errors to the popup.
 */
async function sendMessage(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response) {
    throw new Error('Background service did not respond');
  }
  if (response.error) {
    throw new Error(response.error);
  }
  return response;
}

/**
 * Load settings from background
 */
async function loadSettings() {
  try {
    const response = await sendMessage({
      type: MESSAGE_TYPES.GET_SETTINGS
    });

    const settings = response.settings || {};

    // Update checkboxes
    for (const id of SETTING_IDS) {
      const checkbox = document.getElementById(id);
      if (checkbox && settings[id] !== undefined) {
        checkbox.checked = settings[id];
      }
    }

  } catch (error) {
    console.error('Error loading settings:', error);
    showToast('Failed to load settings', 'error');
  }
}

/**
 * Load cache statistics
 */
async function loadCacheStats() {
  try {
    const response = await sendMessage({
      type: MESSAGE_TYPES.GET_CACHE_STATS
    });

    const stats = response.stats || {};

    // Update UI
    document.getElementById('totalEntries').textContent =
      stats.validEntries?.toLocaleString() || '0';
    document.getElementById('cacheSize').textContent =
      stats.sizeMB || '0';

  } catch (error) {
    console.error('Error loading cache stats:', error);
  }

  await loadStatus();
}

/**
 * Show whether X is currently rate-limiting profile lookups
 */
async function loadStatus() {
  const statusEl = document.getElementById('fetchStatus');
  if (!statusEl) return;

  try {
    const response = await sendMessage({ type: MESSAGE_TYPES.GET_STATUS });
    const until = response.fetcher?.rateLimitedUntil;

    if (until) {
      const time = new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      statusEl.textContent = `⏳ X rate limit reached - lookups resume at ${time}`;
      statusEl.hidden = false;
    } else {
      statusEl.hidden = true;
    }
  } catch (error) {
    statusEl.hidden = true;
  }
}

/**
 * Setup event listeners
 */
function setupEventListeners() {
  // Setting checkboxes
  for (const id of SETTING_IDS) {
    const checkbox = document.getElementById(id);
    if (checkbox) {
      checkbox.addEventListener('change', handleSettingChange);
    }
  }

  // Clear cache button
  document.getElementById('clearCache').addEventListener('click', handleClearCache);

  // Site access (Firefox can revoke it)
  document.getElementById('grantAccess')?.addEventListener('click', handleGrantAccess);

  // Export button
  document.getElementById('exportData').addEventListener('click', handleExport);

  // Import button
  document.getElementById('importData').addEventListener('click', () => {
    if (IS_FIREFOX && !IS_TAB) {
      chrome.tabs.create({ url: chrome.runtime.getURL('src/popup/popup.html?tab=1') });
      window.close();
      return;
    }
    document.getElementById('importFile').click();
  });

  // Import file input
  document.getElementById('importFile').addEventListener('change', handleImport);
}

/**
 * Handle setting change
 */
async function handleSettingChange(event) {
  const checkbox = event.target;
  const settingId = checkbox.id;
  const value = checkbox.checked;

  try {
    await sendMessage({
      type: MESSAGE_TYPES.UPDATE_SETTINGS,
      settings: { [settingId]: value }
    });

  } catch (error) {
    console.error('Error updating setting:', error);
    showToast('Failed to update setting', 'error');
    // Revert checkbox
    checkbox.checked = !value;
  }
}

/**
 * Handle clear cache
 */
async function handleClearCache() {
  // Show confirmation dialog
  const confirmed = await showConfirmDialog(
    'Clear Cache?',
    'This will remove all cached profile data. This action cannot be undone.'
  );

  if (!confirmed) return;

  try {
    await sendMessage({
      type: MESSAGE_TYPES.CLEAR_CACHE
    });

    // Refresh stats
    await loadCacheStats();

    showToast('Cache cleared successfully', 'success');

  } catch (error) {
    console.error('Error clearing cache:', error);
    showToast('Failed to clear cache', 'error');
  }
}

/**
 * Handle data export
 */
async function handleExport() {
  try {
    const response = await sendMessage({
      type: MESSAGE_TYPES.EXPORT_DATA
    });

    // Create downloadable file
    const data = JSON.stringify(response, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    // Generate filename with date
    const date = new Date().toISOString().split('T')[0];
    const filename = `x-flag-export-${date}.json`;

    // Trigger download
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Revoking immediately can cancel the download in some browsers
    setTimeout(() => URL.revokeObjectURL(url), 10000);

    showToast('Data exported successfully', 'success');

  } catch (error) {
    console.error('Error exporting data:', error);
    showToast('Failed to export data', 'error');
  }
}

/**
 * Handle data import
 */
async function handleImport(event) {
  const file = event.target.files[0];
  if (!file) return;

  // Reset input
  event.target.value = '';

  try {
    const text = await file.text();
    const data = JSON.parse(text);

    // Validate data structure
    if (!data || typeof data !== 'object' || (!data.cache && !data.settings)) {
      throw new Error('Invalid data format');
    }

    const response = await sendMessage({
      type: MESSAGE_TYPES.IMPORT_DATA,
      data: data
    });

    // Refresh UI
    await loadSettings();
    await loadCacheStats();

    showToast(`Imported ${response.imported || 0} profiles`, 'success');

  } catch (error) {
    console.error('Error importing data:', error);
    showToast('Failed to import data: ' + error.message, 'error');
  }
}

/**
 * Show toast notification
 */
function showToast(message, type = 'info') {
  // Remove existing toast
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  // Create toast
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;

  document.body.appendChild(toast);

  // Auto remove after 3 seconds
  setTimeout(() => {
    toast.remove();
  }, 3000);
}

/**
 * Show confirmation dialog
 */
function showConfirmDialog(title, message) {
  return new Promise((resolve) => {
    // Create overlay
    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay';

    // Create dialog using DOM APIs
    const dialog = document.createElement('div');
    dialog.className = 'dialog';

    const h3 = document.createElement('h3');
    h3.textContent = title;

    const p = document.createElement('p');
    p.textContent = message;

    const buttonsDiv = document.createElement('div');
    buttonsDiv.className = 'dialog-buttons';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-secondary';
    cancelBtn.textContent = 'Cancel';

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'btn btn-danger';
    confirmBtn.textContent = 'Clear';

    buttonsDiv.appendChild(cancelBtn);
    buttonsDiv.appendChild(confirmBtn);
    dialog.appendChild(h3);
    dialog.appendChild(p);
    dialog.appendChild(buttonsDiv);
    overlay.appendChild(dialog);

    document.body.appendChild(overlay);

    // Handle buttons
    cancelBtn.addEventListener('click', () => {
      overlay.remove();
      resolve(false);
    });

    confirmBtn.addEventListener('click', () => {
      overlay.remove();
      resolve(true);
    });

    // Close on overlay click
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.remove();
        resolve(false);
      }
    });
  });
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', init);
