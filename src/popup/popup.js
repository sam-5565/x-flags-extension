/**
 * Popup Script - Settings UI and cache management
 */

// Message types (duplicated here since popup doesn't have access to content scripts)
const MESSAGE_TYPES = {
  GET_SETTINGS: 'GET_SETTINGS',
  UPDATE_SETTINGS: 'UPDATE_SETTINGS',
  CLEAR_CACHE: 'CLEAR_CACHE',
  GET_CACHE_STATS: 'GET_CACHE_STATS',
  EXPORT_DATA: 'EXPORT_DATA',
  IMPORT_DATA: 'IMPORT_DATA'
};

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

  // Export button
  document.getElementById('exportData').addEventListener('click', handleExport);

  // Import button
  document.getElementById('importData').addEventListener('click', () => {
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
    URL.revokeObjectURL(url);

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
    if (!data.cache && !data.settings) {
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
