/**
 * Username Finder - Finds username elements in the DOM
 */

const UsernameFinder = {
  // Cache of found username elements
  foundElements: new WeakSet(),

  // Regex to validate username format
  usernameRegex: /^[A-Za-z0-9_]{1,15}$/,

  /**
   * Find all username elements on the page
   * @returns {Array<{element: Element, username: string, context: string}>}
   */
  findAll() {
    const results = [];

    // Strategy 1: Find usernames in tweets
    const tweets = document.querySelectorAll('article[data-testid="tweet"]');
    XFlagLogger.log('[XFlag:UsernameFinder] Found tweets:', tweets.length);
    for (const tweet of tweets) {
      const usernameElements = this._findUsernamesInTweet(tweet);
      results.push(...usernameElements);
    }

    // Strategy 2: Find usernames in user cells (lists, followers, etc.)
    const userCells = document.querySelectorAll('[data-testid="UserCell"]');
    XFlagLogger.log('[XFlag:UsernameFinder] Found user cells:', userCells.length);
    for (const cell of userCells) {
      const usernameElements = this._findUsernamesInUserCell(cell);
      results.push(...usernameElements);
    }

    // Strategy 3: Find username in profile header
    const profileHeader = document.querySelector('[data-testid="UserName"]');
    XFlagLogger.log('[XFlag:UsernameFinder] Found profile header:', !!profileHeader);
    if (profileHeader) {
      const usernameElements = this._findUsernamesInProfileHeader(profileHeader);
      results.push(...usernameElements);
    }

    // Strategy 4: Generic fallback - find all username links
    const genericLinks = document.querySelectorAll('a[href^="/"][role="link"]');
    XFlagLogger.log('[XFlag:UsernameFinder] Found generic links:', genericLinks.length);
    for (const link of genericLinks) {
      if (this.foundElements.has(link)) continue;

      const result = this._processGenericLink(link);
      if (result) {
        results.push(result);
      }
    }

    XFlagLogger.log('[XFlag:UsernameFinder] Total results:', results.length);
    return results;
  },

  /**
   * Find new (unprocessed) username elements
   * @returns {Array<{element: Element, username: string, context: string}>}
   */
  findNew() {
    return this.findAll().filter(item => {
      if (!item.element.hasAttribute(CONSTANTS.DATA_ATTRS.PROCESSED)) {
        return true;
      }
      // X recycles DOM nodes while scrolling; a processed link that now
      // points at a different user needs a new badge.
      const processedFor = item.element.getAttribute(CONSTANTS.DATA_ATTRS.USERNAME);
      if (processedFor !== item.username.toLowerCase()) {
        return true;
      }
      // React may also re-render the parent and drop our badge.
      return typeof BadgeInjector !== 'undefined' && !BadgeInjector.get(item.element);
    });
  },

  /**
   * Find usernames in a tweet element
   */
  _findUsernamesInTweet(tweet) {
    const results = [];

    // Find the author's username (in the header)
    // Only target the @username link, not the display name link
    const userNameContainer = tweet.querySelector('[data-testid="User-Name"]');
    if (userNameContainer) {
      const links = userNameContainer.querySelectorAll('a[href^="/"]');
      let foundUsernameLink = false;

      for (const link of links) {
        // Only process links that show @username text (not display name)
        const linkText = link.textContent?.trim();
        if (linkText && linkText.startsWith('@') && !foundUsernameLink) {
          const result = this._processUsernameLink(link, 'tweet-author');
          if (result) {
            results.push(result);
            this.foundElements.add(link);
            foundUsernameLink = true; // Only one badge per author
          }
        } else {
          // Mark other links as processed to avoid duplicate processing
          this.foundElements.add(link);
        }
      }
    }

    // Find mentioned usernames in tweet text
    const tweetText = tweet.querySelector('[data-testid="tweetText"]');
    if (tweetText) {
      const mentionLinks = tweetText.querySelectorAll('a[href^="/"]');
      for (const link of mentionLinks) {
        const result = this._processUsernameLink(link, 'mention');
        if (result) {
          results.push(result);
          this.foundElements.add(link);
        }
      }
    }

    // Find quoted tweet author - only the @username link
    const quotedTweet = tweet.querySelector('[data-testid="quoteTweet"]');
    if (quotedTweet) {
      const quotedUserName = quotedTweet.querySelector('[data-testid="User-Name"]');
      if (quotedUserName) {
        const links = quotedUserName.querySelectorAll('a[href^="/"]');
        let foundQuotedUsernameLink = false;

        for (const link of links) {
          const linkText = link.textContent?.trim();
          if (linkText && linkText.startsWith('@') && !foundQuotedUsernameLink) {
            const result = this._processUsernameLink(link, 'quoted-author');
            if (result) {
              results.push(result);
              this.foundElements.add(link);
              foundQuotedUsernameLink = true;
            }
          } else {
            this.foundElements.add(link);
          }
        }
      }
    }

    return results;
  },

  /**
   * Find usernames in a user cell
   */
  _findUsernamesInUserCell(cell) {
    const results = [];

    const links = cell.querySelectorAll('a[href^="/"]');
    for (const link of links) {
      const result = this._processUsernameLink(link, 'user-cell');
      if (result) {
        results.push(result);
        this.foundElements.add(link);
      }
    }

    return results;
  },

  /**
   * Find username in profile header
   */
  _findUsernamesInProfileHeader(header) {
    // Display names may themselves look like "@SomeBrand", so prefer the
    // span matching the handle in the URL and otherwise take the last
    // "@..." span (X renders the handle after the display name).
    const pathUser = (location.pathname.match(/^\/([A-Za-z0-9_]{1,15})(?:\/|$)/) || [])[1];
    let chosen = null;

    for (const span of header.querySelectorAll('span')) {
      const text = span.textContent?.trim();
      if (!text || !text.startsWith('@')) continue;

      const username = text.substring(1);
      if (!this._isValidUsername(username)) continue;

      if (pathUser && username.toLowerCase() === pathUser.toLowerCase()) {
        chosen = { span, username };
        break;
      }
      chosen = { span, username };
    }

    if (!chosen) return [];

    this.foundElements.add(chosen.span);
    return [{
      element: chosen.span,
      username: chosen.username,
      context: 'profile-header'
    }];
  },

  /**
   * Process a potential username link
   */
  _processUsernameLink(link, context) {
    const href = link.getAttribute('href');
    if (!href) return null;

    // Extract username from href
    const match = href.match(/^\/([A-Za-z0-9_]{1,15})(?:$|\/|\?)/);
    if (!match) return null;

    const username = match[1];

    // Skip non-username paths
    if (this._isReservedPath(username)) {
      return null;
    }

    // Verify this looks like a username link (not just any link to a user page)
    // Username links typically contain the username text or are in specific containers
    const linkText = link.textContent?.trim().toLowerCase();
    const lowerUsername = username.toLowerCase();

    // Check if link text is the username (with or without @)
    if (linkText === `@${lowerUsername}` ||
        (linkText === lowerUsername && !this._hasHandleLinkNearby(link, lowerUsername))) {
      return {
        element: link,
        username: username,
        context: context
      };
    }

    // Check if this link is in a User-Name container
    const isInUserNameContainer = link.closest('[data-testid="User-Name"]');
    if (isInUserNameContainer && linkText && linkText.startsWith('@')) {
      return {
        element: link,
        username: username,
        context: context
      };
    }

    return null;
  },

  /**
   * Whether a separate "@username" link for the same user sits in the same
   * user block. When a display name equals the handle (common), both links
   * match the username text and we'd otherwise add two badges.
   */
  _hasHandleLinkNearby(link, lowerUsername) {
    const container = link.closest(
      '[data-testid="UserCell"], [data-testid="User-Name"], [data-testid="HoverCard"], article'
    ) || link.parentElement;
    if (!container) return false;

    const handle = `@${lowerUsername}`;
    for (const other of container.querySelectorAll('a[href^="/"]')) {
      if (other !== link && other.textContent?.trim().toLowerCase() === handle) {
        return true;
      }
    }
    return false;
  },

  /**
   * Process a generic link that might be a username
   */
  _processGenericLink(link) {
    const href = link.getAttribute('href');
    if (!href) return null;

    // Must be a simple /{username} path
    const match = href.match(/^\/([A-Za-z0-9_]{1,15})$/);
    if (!match) return null;

    const username = match[1];

    // Skip non-username paths
    if (this._isReservedPath(username)) {
      return null;
    }

    // The link text should be the username or @username
    const linkText = link.textContent?.trim().toLowerCase();
    const lowerUsername = username.toLowerCase();
    if (linkText !== `@${lowerUsername}` &&
        (linkText !== lowerUsername || this._hasHandleLinkNearby(link, lowerUsername))) {
      return null;
    }

    return {
      element: link,
      username: username,
      context: 'generic'
    };
  },

  /**
   * Whether a first path segment is an X page rather than a username
   */
  _isReservedPath(segment) {
    return CONSTANTS.RESERVED_PATHS.includes(segment.toLowerCase());
  },

  /**
   * Validate username format
   */
  _isValidUsername(username) {
    return this.usernameRegex.test(username);
  },

  /**
   * Mark an element as processed
   */
  markProcessed(element, username) {
    element.setAttribute(CONSTANTS.DATA_ATTRS.PROCESSED, 'true');
    if (username) {
      element.setAttribute(CONSTANTS.DATA_ATTRS.USERNAME, username.toLowerCase());
    }
  },

  /**
   * Check if element is already processed
   */
  isProcessed(element) {
    return element.hasAttribute(CONSTANTS.DATA_ATTRS.PROCESSED);
  },

  /**
   * Clear processing markers (useful for refresh)
   */
  clearProcessed() {
    const processed = document.querySelectorAll(`[${CONSTANTS.DATA_ATTRS.PROCESSED}]`);
    for (const el of processed) {
      el.removeAttribute(CONSTANTS.DATA_ATTRS.PROCESSED);
      el.removeAttribute(CONSTANTS.DATA_ATTRS.USERNAME);
    }
    this.foundElements = new WeakSet();
  }
};

// Make available globally
if (typeof window !== 'undefined') {
  window.UsernameFinder = UsernameFinder;
}
