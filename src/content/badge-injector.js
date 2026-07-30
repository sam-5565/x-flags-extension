/**
 * Badge Injector - Creates and injects flag badges into the DOM
 */

const BadgeInjector = {
  // Current settings
  settings: null,

  // Keep each injected badge associated with its username element.
  injectedBadges: new WeakMap(),

  /**
   * Initialize with settings
   */
  init(settings) {
    this.settings = settings || CONSTANTS.DISPLAY_DEFAULTS;
  },

  /**
   * Update settings
   */
  updateSettings(settings) {
    this.settings = { ...this.settings, ...settings };
  },

  /**
   * Create a badge container for a profile
   * @param {Object} profileData - Profile data from cache/fetcher
   * @returns {HTMLElement} Badge container element
   */
  createBadge(profileData) {
    const container = document.createElement('span');
    container.className = CONSTANTS.CSS_CLASSES.BADGE_CONTAINER;

    if (profileData?.isSuspended) {
      container.appendChild(this._createSuspendedBadge());
      return container;
    }

    if (!profileData || profileData.error) {
      // Error state
      if (profileData?.notFound) {
        // Don't show anything for not found
        return null;
      } else {
        container.appendChild(this._createErrorBadge());
      }
      return container;
    }

    const elements = [];

    // Protected account icon
    if (profileData.isProtected && this.settings.showProtectedIcon) {
      elements.push(this._createProtectedIcon());
    }

    // Based-in flag
    if (profileData.basedIn && this.settings.showBasedIn) {
      const flag = getFlag(profileData.basedIn.country);
      const hasMismatch = this._checkMismatch(profileData);
      if (flag) {
        elements.push(this._createFlagSpan(flag, profileData.basedIn.country, 'based-in', hasMismatch));
      } else {
        // No flag found - show text label
        elements.push(this._createTextLabel(profileData.basedIn.country, 'based-in', hasMismatch));
      }
    }

    // Connected-via flag
    if (profileData.connectedVia && this.settings.showConnectedVia) {
      const flag = getFlag(profileData.connectedVia.country);
      const hasMismatch = this._checkMismatch(profileData);
      if (flag) {
        elements.push(this._createFlagSpan(flag, profileData.connectedVia.raw, 'connected-via', hasMismatch));
      } else {
        // No flag found - show text label
        elements.push(this._createTextLabel(profileData.connectedVia.country, 'connected-via', hasMismatch));
      }
    }

    // VPN warning
    if (profileData.hasVpnWarning && this.settings.showVpnWarning) {
      elements.push(this._createVpnWarning());
    }

    // Join year
    if (profileData.joinedYear && this.settings.showYear) {
      elements.push(this._createYearSpan(profileData.joinedYear));
    }

    if (elements.length === 0) {
      return null;
    }

    elements.forEach(el => container.appendChild(el));

    // Add tooltip container if needed
    this._addTooltipListeners(container);

    return container;
  },

  /**
   * Create a loading badge
   */
  createLoadingBadge() {
    const container = document.createElement('span');
    container.className = `${CONSTANTS.CSS_CLASSES.BADGE_CONTAINER} ${CONSTANTS.CSS_CLASSES.LOADING}`;
    const spinner = document.createElement('span');
    spinner.className = 'x-flag-spinner';
    container.appendChild(spinner);
    return container;
  },

  /**
   * Inject badge next to a username element
   * @param {HTMLElement} usernameElement - The username element
   * @param {HTMLElement} badge - The badge to inject
   */
  inject(usernameElement, badge) {
    if (!usernameElement || !badge) return;

    const existingBadge = this.get(usernameElement);

    if (existingBadge) {
      existingBadge.replaceWith(badge);
    } else {
      // Insert after the username element
      usernameElement.insertAdjacentElement('afterend', badge);
    }

    this.injectedBadges.set(usernameElement, badge);
  },

  /**
   * Get the badge belonging to a username element.
   */
  get(usernameElement) {
    if (!usernameElement) return null;

    const trackedBadge = this.injectedBadges.get(usernameElement);
    if (trackedBadge?.isConnected) {
      return trackedBadge;
    }

    const adjacentBadge = usernameElement.nextElementSibling;
    if (adjacentBadge?.classList.contains(CONSTANTS.CSS_CLASSES.BADGE_CONTAINER)) {
      this.injectedBadges.set(usernameElement, adjacentBadge);
      return adjacentBadge;
    }

    return null;
  },

  /**
   * Remove badge from a username element
   */
  remove(usernameElement) {
    if (!usernameElement) return;

    const badge = this.get(usernameElement);

    if (badge) {
      badge.remove();
    }
    this.injectedBadges.delete(usernameElement);
  },

  /**
   * Update an existing badge with new data
   */
  update(usernameElement, profileData) {
    const newBadge = this.createBadge(profileData);
    if (newBadge) {
      this.inject(usernameElement, newBadge);
    } else {
      this.remove(usernameElement);
    }
  },

  /**
   * Create flag span element
   */
  _createFlagSpan(flag, tooltip, type, hasMismatch) {
    const span = document.createElement('span');
    span.className = CONSTANTS.CSS_CLASSES.FLAG;
    if (hasMismatch && this.settings.showMismatchHighlight) {
      span.classList.add(CONSTANTS.CSS_CLASSES.MISMATCH);
    }
    span.setAttribute('data-type', type);
    span.setAttribute('data-tooltip', tooltip);
    span.textContent = flag;
    return span;
  },

  /**
   * Create VPN warning element
   */
  _createVpnWarning() {
    const span = document.createElement('span');
    span.className = CONSTANTS.CSS_CLASSES.WARNING;
    span.setAttribute('data-tooltip', 'X detected VPN/location mismatch');
    span.textContent = '⚠️';
    return span;
  },

  /**
   * Create year span element
   */
  _createYearSpan(year) {
    const shortYear = String(year).slice(-2);
    const span = document.createElement('span');
    span.className = CONSTANTS.CSS_CLASSES.YEAR;
    span.setAttribute('data-tooltip', `Joined ${year}`);
    span.textContent = `'${shortYear}`;
    return span;
  },

  /**
   * Create text label when no flag emoji is available
   */
  _createTextLabel(text, type, hasMismatch) {
    const span = document.createElement('span');
    span.className = `${CONSTANTS.CSS_CLASSES.FLAG} x-flag-text`;
    if (hasMismatch && this.settings.showMismatchHighlight) {
      span.classList.add(CONSTANTS.CSS_CLASSES.MISMATCH);
    }
    span.setAttribute('data-type', type);
    span.setAttribute('data-tooltip', text);
    // Shorten long region names
    span.textContent = text.length > 12 ? text.substring(0, 10) + '…' : text;
    return span;
  },

  /**
   * Create protected icon element
   */
  _createProtectedIcon() {
    const span = document.createElement('span');
    span.className = CONSTANTS.CSS_CLASSES.PROTECTED;
    span.setAttribute('data-tooltip', 'Protected account');
    span.textContent = '🔒';
    return span;
  },

  /**
   * Create suspended badge element
   */
  _createSuspendedBadge() {
    const span = document.createElement('span');
    span.className = CONSTANTS.CSS_CLASSES.ERROR;
    span.setAttribute('data-tooltip', 'Account suspended');
    span.textContent = '🚫';
    return span;
  },

  /**
   * Create error badge element
   */
  _createErrorBadge() {
    const span = document.createElement('span');
    span.className = CONSTANTS.CSS_CLASSES.ERROR;
    span.setAttribute('data-tooltip', 'Failed to load');
    span.textContent = '❌';
    return span;
  },

  /**
   * Check if there's a country mismatch
   */
  _checkMismatch(profileData) {
    if (!profileData.basedIn || !profileData.connectedVia) {
      return false;
    }

    const basedInCountry = normalizeCountryName(profileData.basedIn.country).toLowerCase();
    const connectedViaCountry = normalizeCountryName(profileData.connectedVia.country).toLowerCase();

    return basedInCountry !== connectedViaCountry;
  },

  /**
   * Add tooltip listeners to badge elements
   */
  _addTooltipListeners(container) {
    const tooltipElements = container.querySelectorAll('[data-tooltip]');

    for (const el of tooltipElements) {
      el.addEventListener('mouseenter', this._showTooltip.bind(this));
      el.addEventListener('mouseleave', this._hideTooltip.bind(this));
    }
  },

  /**
   * Show tooltip
   */
  _showTooltip(event) {
    const target = event.target;
    const tooltipText = target.getAttribute('data-tooltip');

    if (!tooltipText) return;

    // Remove any existing tooltip
    this._hideTooltip();

    // Create tooltip element
    const tooltip = document.createElement('div');
    tooltip.className = CONSTANTS.CSS_CLASSES.TOOLTIP;
    tooltip.textContent = tooltipText;

    // Position tooltip
    const rect = target.getBoundingClientRect();
    tooltip.style.position = 'fixed';
    tooltip.style.left = `${rect.left + rect.width / 2}px`;
    tooltip.style.top = `${rect.bottom + 5}px`;
    tooltip.style.transform = 'translateX(-50%)';

    document.body.appendChild(tooltip);

    // Store reference for cleanup
    target._tooltip = tooltip;
  },

  /**
   * Hide tooltip
   */
  _hideTooltip(event) {
    if (event?.target?._tooltip) {
      event.target._tooltip.remove();
      delete event.target._tooltip;
    } else {
      // Fallback: remove all tooltips
      const tooltips = document.querySelectorAll(`.${CONSTANTS.CSS_CLASSES.TOOLTIP}`);
      tooltips.forEach(t => t.remove());
    }
  },

};

// Make available globally
if (typeof window !== 'undefined') {
  window.BadgeInjector = BadgeInjector;
}
