# VibeExtract

A Chrome extension that lets you visually select any element on a webpage and export it as a pixel-perfect, standalone component — ready for Claude, React, Tailwind, or any frontend framework.

## What It Does

Point. Click. Extract. VibeExtract captures the full visual fidelity of any UI component — styles, fonts, icons, layout, hover states — and exports it in two formats:

- **`.toon`** — Token-Optimized Object Notation, a compact format designed for LLMs like Claude. Paste it and say _"Replicate this component in React + Tailwind"_
- **`.html`** — A fully self-contained preview file you can open in any browser

## Features

### Element Selection
- **Click to select** any element on the page
- **Shift+Click** to multi-select multiple elements
- **Hover highlighting** shows elements with a red outline as you move your mouse
- **Visual overlay** covers all selected elements with a blue bounding box

### DOM Navigation
- **Alt/Opt + Arrow Up** — navigate to the parent element
- **Alt/Opt + Arrow Down** — navigate to the first child element
- Auto-selects the navigated element so you can quickly drill up to `<body>` for a full-page grab

### Full Page Export
- One shortcut to select `<body>` and export the entire page instantly

### Smart Style Capture
- **Computed styles** extracted and deduplicated into shared CSS classes
- **Hover states** captured for interactive elements (links, buttons, inputs)
- **Pseudo-elements** (`::before`, `::after`) including avatar circles and icon content
- **Web fonts** auto-detected and included from Google Fonts (Inter, Roboto, Poppins, etc.)
- **Icon fonts** auto-detected (Material Icons, Material Symbols, Font Awesome)
- **Layout preservation** — strict sizing for media, fluid sizing for text
- **RGB to hex** conversion, transparent color removal, default value pruning

### Shadow DOM & iframe Support
- Works inside open Shadow DOM elements
- Broadcasts commands across all frames/iframes

### Dynamic Content Freezing
- Elements are cloned at selection time, so rotating content (like GitHub ProTips) is captured exactly as you see it

## Keyboard Shortcuts

All shortcuts are fully customizable from the popup settings panel.

| Action | Mac | Windows/Linux |
|---|---|---|
| Start Selection | `Cmd+Shift+S` | `Ctrl+Shift+S` |
| Clear Selection | `Escape` | `Escape` |
| Export Selected | `Cmd+Shift+E` | `Ctrl+Shift+E` |
| Extract Full Page | `Cmd+Shift+X` | `Ctrl+Shift+X` |
| Navigate Parent | `Alt+Arrow Up` | `Alt+Arrow Up` |
| Navigate Child | `Alt+Arrow Down` | `Alt+Arrow Down` |

## Installation

1. Clone this repo
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select this folder
5. Pin the extension from the toolbar for quick access

## Usage

1. Click the VibeExtract icon in your toolbar (auto-enters selection mode)
2. Hover over elements to preview, click to select
3. Use **Shift+Click** to add more elements, **Alt+Arrows** to navigate the DOM tree
4. Press **Export** or hit the export shortcut — two files download:
   - `component.toon` — feed this to Claude or any LLM
   - `preview.html` — open in browser to verify the capture

### Full Page Workflow

Hit `Cmd+Shift+X` / `Ctrl+Shift+X` to grab the entire page in one keystroke.

### Customize Shortcuts

Click **"Customize Shortcuts"** in the popup to remap any shortcut. On Mac, you get a **Cmd** modifier; on all platforms, you get **Ctrl**, **Shift**, and **Alt/Opt**.

## Export Formats

### TOON (Token-Optimized Object Notation)
A compact, LLM-friendly format that uses abbreviated keys and minimal syntax. Includes element structure, shared style classes, hover states, and all visual properties. Optimized for low token usage when prompting Claude.

### HTML Preview
A standalone HTML file with all CSS inlined, font imports included, and box-sizing normalized. Opens directly in any browser — what you see is what was captured.

## Permissions

| Permission | Why |
|---|---|
| `activeTab` | Access the current tab to inject selection UI |
| `scripting` | Run the content script on the page |
| `webNavigation` | Support iframe/frame selection |
| `storage` | Persist your custom shortcuts |
| `downloads` | Save the exported `.toon` and `.html` files |

## License

MIT
