# DOM Heist — Privacy Policy

_Last updated: 21 August 2026_

DOM Heist does not collect, transmit, sell, or share any user data.

## What the extension does

DOM Heist extracts an element you point at on a page you are viewing and saves it as a
standalone HTML file, plus a plain-text TOON description of the same component. All of this
work happens locally, inside your browser and on your computer.

## Data we collect

**None.** There are no analytics, no telemetry, no crash reporting, no accounts, no logins,
and no server operated by this extension. Nothing you capture, and no information about the
pages you visit, is sent to us or to any third party — because there is nowhere for it to be
sent to.

## Data stored on your device

Two things are stored locally and never leave your machine:

- **Your keyboard shortcuts**, in `chrome.storage.sync`, so your chosen keys persist across
  your signed-in Chrome profiles. This is synced by Chrome itself, to your own Google account.
- **Your 10 most recent captures**, in the browser's local IndexedDB, to power the "recent
  captures" list. Older entries are pruned automatically by count and by a 60 MB budget, and
  you can delete any entry, or all of them, from the export tab at any time. Removing the
  extension deletes this store.

Files you choose to save go to your own downloads folder.

## Network requests

The extension makes exactly one kind of outbound request: downloading the **font files**
(woff2/woff/otf/ttf) that a component you captured already references, so the saved file
renders with the right typography when opened offline. These go to whatever host already
serves that page's fonts, are sent with credentials omitted, and retrieve only font binaries.
No page content, capture data, URL, or identifier is included in these requests.

## Permissions

Each permission the extension requests and why it is needed is documented in the
[README](README.md#permissions).

## Remote code

None. All code is bundled in the extension package. The extension does not download,
evaluate, or execute any remotely-hosted code.

## Changes

If this policy ever changes, the updated version will be published at this URL and the date
above will be revised.

## Contact

Questions about this policy: open an issue on the
[project repository](https://github.com/Astro-Dude/VibeExtract/issues).
