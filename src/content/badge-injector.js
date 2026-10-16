/**
 * Badge Injector - Creates and injects flag badges into the DOM
 */

const BadgeInjector = {
  // Current settings
  settings: null,

  // Keep each injected badge associated with its username element.
  injectedBadges: new WeakMap(),

  // The single tooltip currently shown, and the element it belongs to.
  activeTooltip: null,
  tooltipOwner: null,

  /**
   * Initialize with settings
   */
  init(settings) {
    this.settings = { ...CONSTANTS.DISPLAY_DEFAULTS, ...settings };

    // Tooltips are fixed-position, so hide them when the page moves. X also
    // removes tweets from the DOM while scrolling, which would otherwise
    // leave an orphaned tooltip on screen.
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('scroll', () => this._hideTooltip(), { passive: true, capture: true });
      window.addEventListener('blur', () => this._hideTooltip());
    }
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

    const hasMismatch = this._checkMismatch(profileData);

    // Based-in flag
    const basedIn = this._placeName(profileData.basedIn);
    if (basedIn && this.settings.showBasedIn) {
      const flag = getFlag(basedIn);
      const tooltip = `Account based in: ${basedIn}`;
      elements.push(flag
        ? this._createFlagSpan(flag, tooltip, 'based-in', hasMismatch)
        : this._createTextLabel(basedIn, tooltip, 'based-in', hasMismatch));
    }

    // Connected-via flag
    const connectedVia = this._placeName(profileData.connectedVia);
    if (connectedVia && this.settings.showConnectedVia) {
      const flag = getFlag(connectedVia);
      const rawSource = typeof profileData.connectedVia.raw === 'string'
        ? profileData.connectedVia.raw
        : connectedVia;
      const tooltip = `Connected via: ${rawSource}`;
      elements.push(flag
        ? this._createFlagSpan(flag, tooltip, 'connected-via', hasMismatch)
        : this._createTextLabel(connectedVia, tooltip, 'connected-via', hasMismatch));
    }

    // VPN warning
    if (profileData.hasVpnWarning && this.settings.showVpnWarning) {
      elements.push(this._createVpnWarning());
    }

    // Join year
    if (profileData.joinedYear && this.settings.showYear) {
      elements.push(this._createYearSpan(
        profileData.joinedYear,
        profileData.joinedMonth,
        profileData.usernameChanges
      ));
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
   * Country/region text from a {country, raw} place, or null if unusable
   */
  _placeName(place) {
    if (!place || typeof place !== 'object') return null;
    const name = typeof place.country === 'string' && place.country.trim()
      ? place.country.trim()
      : (typeof place.raw === 'string' ? place.raw.trim() : '');
    return name || null;
  },

  /**
   * Remove badges whose username element is gone. React removes nodes it
   * owns but leaves our sibling badge behind, which would otherwise sit
   * next to unrelated content.
   */
  removeOrphans() {
    const badges = document.querySelectorAll(`.${CONSTANTS.CSS_CLASSES.BADGE_CONTAINER}`);
    for (const badge of badges) {
      const owner = badge.previousElementSibling;
      if (!owner || !owner.hasAttribute(CONSTANTS.DATA_ATTRS.USERNAME)) {
        badge.remove();
      }
    }
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
    let newBadge = this.createBadge(profileData);
    if (!newBadge) {
      // Keep an empty marker so the element isn't treated as unprocessed and
      // re-rendered on every DOM change.
      newBadge = document.createElement('span');
      newBadge.className = `${CONSTANTS.CSS_CLASSES.BADGE_CONTAINER} x-flag-empty`;
    }
    this.inject(usernameElement, newBadge);
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
    this._setLabel(span, tooltip);
    span.textContent = flag;
    return span;
  },

  /**
   * Give an icon a tooltip and an accessible name.
   */
  _setLabel(span, label) {
    span.setAttribute('data-tooltip', label);
    span.setAttribute('aria-label', label);
    span.setAttribute('role', 'img');
  },

  /**
   * Create VPN warning element
   */
  _createVpnWarning() {
    const span = document.createElement('span');
    span.className = CONSTANTS.CSS_CLASSES.WARNING;
    this._setLabel(span, 'X says this account may be using a VPN or proxy');
    span.textContent = '⚠️';
    return span;
  },

  /**
   * Create year span element
   */
  _createYearSpan(year, month, usernameChanges) {
    const shortYear = String(year).slice(-2);
    const span = document.createElement('span');
    span.className = CONSTANTS.CSS_CLASSES.YEAR;
    let tooltip = month ? `Joined ${month} ${year}` : `Joined ${year}`;
    if (Number.isFinite(usernameChanges) && usernameChanges > 0) {
      tooltip += ` · username changed ${usernameChanges} time${usernameChanges === 1 ? '' : 's'}`;
    }
    this._setLabel(span, tooltip);
    span.textContent = `'${shortYear}`;
    return span;
  },

  /**
   * Create text label when no flag emoji is available
   */
  _createTextLabel(text, tooltip, type, hasMismatch) {
    const span = document.createElement('span');
    span.className = `${CONSTANTS.CSS_CLASSES.FLAG} x-flag-text`;
    if (hasMismatch && this.settings.showMismatchHighlight) {
      span.classList.add(CONSTANTS.CSS_CLASSES.MISMATCH);
    }
    span.setAttribute('data-type', type);
    this._setLabel(span, tooltip);
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
    this._setLabel(span, 'Protected account');
    span.textContent = '🔒';
    return span;
  },

  /**
   * Create suspended badge element
   */
  _createSuspendedBadge() {
    const span = document.createElement('span');
    span.className = CONSTANTS.CSS_CLASSES.ERROR;
    this._setLabel(span, 'Account suspended or unavailable');
    span.textContent = '🚫';
    return span;
  },

  /**
   * Create error badge element
   */
  _createErrorBadge() {
    const span = document.createElement('span');
    span.className = CONSTANTS.CSS_CLASSES.ERROR;
    this._setLabel(span, 'Failed to load');
    span.textContent = '❌';
    return span;
  },

  /**
   * Check if "based in" and "connected via" name different countries.
   * Names are compared by ISO code so "United States" matches "US App
   * Store". Regions such as "Europe" or "South Asia" are too coarse to call
   * a mismatch, so they never count as one.
   */
  _checkMismatch(profileData) {
    if (!profileData.basedIn || !profileData.connectedVia) {
      return false;
    }

    const basedInCode = getCountryCode(this._placeName(profileData.basedIn));
    const connectedViaCode = getCountryCode(this._placeName(profileData.connectedVia));

    return Boolean(basedInCode && connectedViaCode && basedInCode !== connectedViaCode);
  },

  /**
   * Add tooltip listeners to badge elements
   */
  _addTooltipListeners(container) {
    const tooltipElements = container.querySelectorAll('[data-tooltip]');

    for (const el of tooltipElements) {
      el.addEventListener('mouseenter', event => this._showTooltip(event.currentTarget));
      el.addEventListener('mouseleave', () => this._hideTooltip());
    }
  },

  /**
   * Show tooltip for an element with a data-tooltip attribute
   */
  _showTooltip(target) {
    const tooltipText = target?.getAttribute('data-tooltip');
    if (!tooltipText) return;

    this._hideTooltip();

    const tooltip = document.createElement('div');
    tooltip.className = CONSTANTS.CSS_CLASSES.TOOLTIP;
    tooltip.setAttribute('role', 'tooltip');
    tooltip.textContent = tooltipText;

    // Position below the icon, kept inside the viewport horizontally
    const rect = target.getBoundingClientRect();
    const center = rect.left + rect.width / 2;
    const margin = 8;
    tooltip.style.position = 'fixed';
    tooltip.style.left = `${Math.min(Math.max(center, margin), window.innerWidth - margin)}px`;
    tooltip.style.top = `${rect.bottom + 5}px`;
    tooltip.style.transform = 'translateX(-50%)';

    document.body.appendChild(tooltip);

    this.activeTooltip = tooltip;
    this.tooltipOwner = target;
  },

  /**
   * Hide the active tooltip (and any stray ones)
   */
  _hideTooltip() {
    if (this.activeTooltip) {
      this.activeTooltip.remove();
    }
    this.activeTooltip = null;
    this.tooltipOwner = null;

    if (typeof document !== 'undefined' && document.querySelectorAll) {
      document.querySelectorAll(`.${CONSTANTS.CSS_CLASSES.TOOLTIP}`).forEach(t => t.remove());
    }
  }
};

// Make available globally
if (typeof window !== 'undefined') {
  window.BadgeInjector = BadgeInjector;
}
