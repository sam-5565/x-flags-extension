# X Flags Extension

Display country flags next to usernames on X.com (Twitter).

## Features

- Shows country flags from X's "Account based in" and "Connected via" data
- Highlights accounts whose two countries differ, and shows X's VPN warning
- Displays account join year (hover for month and username-change count)
- Hover, click or press Enter on the 🌐 icon to load a profile
- Works on feeds, search results, and profile pages
- Caches profile metadata locally to reduce requests to X, and backs off
  automatically when X rate-limits lookups
- Sends no analytics or profile data to third parties

## Installation

### Chrome & Brave

1. Download the latest release or clone this repository
2. Open Chrome/Brave and go to `chrome://extensions/`
3. Enable "Developer mode" (toggle in top right)
4. Click "Load unpacked"
5. Select the cloned `x-flags-extension` folder

### Firefox 142+

1. Download the latest release or clone this repository
2. Open Firefox and go to `about:debugging`
3. Click "This Firefox" in the sidebar
4. Click "Load Temporary Add-on"
5. Select the `manifest.json` file from the folder

### From Stores (Coming Soon)

- Chrome Web Store: *Pending review*
- Firefox Add-ons: *Pending review*

## Usage

1. Go to [x.com](https://x.com) and log in
2. Browse any feed, search results, or profile
3. Hover over (or click) the 🌐 next to a username to load its country flags.
   Every mention of that user on the page updates at once, and the result is
   cached for next time.

| Badge | Meaning |
|-------|---------|
| 🇺🇸 🇺🇸 | Account based in / connected via (hover for details) |
| highlighted flags | The two countries differ |
| ⚠️ | X says the account may be using a VPN or proxy |
| '16 | Year the account joined |
| — | X has no location data for this account |
| ⏳ | X is rate-limiting lookups; try again later |

## Screenshots

![Screenshot](screenshots/screen-shot.png)

## Privacy

- No analytics, telemetry, or profile data is sent to third-party servers
- Profile lookups are requested directly from X while you are signed in
- Profile data is cached locally in your browser
- Only reads publicly visible profile information from X.com

## Development

Run the dependency-free validation suite before loading or publishing the
extension:

```bash
npm test
```

The checks validate JavaScript syntax, manifest-referenced files, the Firefox
background script list, country lookup, badge rendering, profile fetching and
cache behavior.

### Releasing

```bash
npm run package
```

builds `dist/x-flags-chrome-<version>.zip` and `dist/x-flags-firefox-<version>.zip`
with a manifest trimmed for each store.

The **Publish** GitHub Actions workflow (run it manually, or push a `v*` tag)
builds both packages and uploads them when these repository secrets are set:

- Chrome Web Store: `CHROME_EXTENSION_ID`, `CHROME_CLIENT_ID`,
  `CHROME_CLIENT_SECRET`, `CHROME_REFRESH_TOKEN`
- Firefox Add-ons: `AMO_JWT_ISSUER`, `AMO_JWT_SECRET`

## License

All Rights Reserved
