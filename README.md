# X Flags Extension

Display country flags next to usernames on X.com (Twitter).

## Features

- Shows country flags based on user profile location
- Displays account join year
- Hover over usernames to see detailed info
- Works on feeds, search results, and profile pages
- Caches profile metadata locally to reduce requests to X
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
3. Hover over usernames to see country flags appear

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

The checks validate JavaScript syntax, manifest-referenced files, shared country
helpers, and cache import behavior.

## License

All Rights Reserved
