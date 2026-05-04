# VibeExtract

A Chrome extension that lets you visually select any element on a webpage and export it as a pixel-perfect, standalone component — ready for Claude, React, Tailwind, or any frontend framework.

## What It Does

Point. Click. Extract. VibeExtract captures the full visual fidelity of any UI component — styles, fonts, icons, layout, hover states — and exports it in two formats:

- **`.toon`** — Token-Optimized Object Notation, a compact format designed for LLMs like Claude. Paste it and say _"Replicate this component in React + Tailwind"_
- **`.html`** — A fully self-contained preview file you can open in any browser

## Features

### Element Selection
- **Click to select** — small leaf elements (form fields, overlay buttons, icons, headings, plain spans) auto-expand to their nearest visually distinct or structural ancestor, so a click on a search field captures the whole field card instead of just the bare `<input>`
- **Alt+Click** — bypass smart expansion and take the exact element under the cursor
- **Shift+Click** — multi-select (also bypasses smart expansion)
- **Hover highlighting** shows elements with a red outline as you move your mouse
- **Visual overlay** covers all selected elements with a blue bounding box
- **Auto-activates** selection mode when the popup opens — no extra clicks

### DOM Navigation
- **Alt/Opt + Arrow Up** — navigate to the parent element
- **Alt/Opt + Arrow Down** — navigate to the first child *or* back to the node you came from (the wheel/keyboard navigator keeps a back-stack so over-scrolling up no longer leaves you stuck)
- **Scroll navigation** — scroll while hovering to walk parent ↔ child along the same path
- Auto-selects the navigated element so you can quickly drill up or down the DOM tree

### Full Page Export
- One shortcut (`Cmd+Shift+X` / `Ctrl+Shift+X`) to select `<body>` and export the entire page instantly

### Smart Style Capture
- **Computed styles** extracted and deduplicated into shared CSS classes
- **Pseudo-elements** — both `::before` and `::after` captured independently as real `.classN::before` / `::after` rules in the output stylesheet, including decorative pseudos with empty `content`. Captures `box-shadow`, `transform`, positioning, fonts, padding/margin, filter, opacity, etc.
- **Parent layout context** — when you select inner elements, the surrounding flex/grid container's display, flex/grid props, gap, padding, and named grid areas are wrapped around your selection so the layout still flows correctly. CSS Grid templates with `grid-template-areas` are preserved
- **Web fonts** auto-detected and included from Google Fonts (Inter, Roboto, Poppins, etc.)
- **Icon fonts** auto-detected (Material Icons, Material Symbols, Font Awesome)
- **Layout preservation** — strict sizing for media, fluid sizing for text, and root structural elements adapt to the export iframe via `max-width: 100%` instead of pixel-locked min-width
- **Position normalization** — `position: absolute|fixed` selections that have no positioned ancestor in the export get their offsets cleared so they don't render relative to `<body>`
- **RGB to hex** conversion, transparent color removal, default value pruning
- **Primary font detection** — identifies and displays the dominant font used in exports

### Shadow DOM & iframe Support
- Works inside open Shadow DOM elements
- Broadcasts commands across all frames/iframes on the page

### Dynamic Content Freezing
- Elements are cloned at selection time, so rotating content (like GitHub ProTips) is captured exactly as you see it

### Export Preview Page
- On export, a new tab opens with three views:
  - **Preview** — live rendered HTML preview of the captured component, auto-sized to content
  - **HTML** — syntax-highlighted source with copy button, file size, and detected primary font
  - **TOON** — the LLM-optimized format with copy button, file size, and detected primary font
- **Diagnostics panel** — collapsible panel above the tabs shows how many top-level selections were captured, how many nodes were dropped by the visibility filter, registry sizes, and per-selection bounding boxes. Surfaces silent filtering so an empty preview is never a mystery
- **Save .html** — downloads the HTML file
- **Save .toon** — downloads the TOON file
- **Save Both** — downloads both files at once
- **Clipboard auto-copy** — after each save, the full file path is automatically copied to your clipboard so you can paste it directly into Claude or any tool

### Cross-Platform Shortcuts
- All shortcuts adapt to your platform: **Cmd** on Mac, **Ctrl** on Windows/Linux
- **Alt** label changes to **Opt** on Mac
- Fully customizable from the popup settings panel

## Keyboard Shortcuts

All shortcuts are fully customizable from the popup settings panel.

| Action | Mac | Windows/Linux |
|---|---|---|
| Start Selection | `Cmd+Shift+S` | `Ctrl+Shift+S` |
| Clear Selection | `Escape` | `Escape` |
| Export Selected | `Cmd+Shift+E` | `Ctrl+Shift+E` |
| Extract Full Page | `Cmd+Shift+X` | `Ctrl+Shift+X` |
| Navigate Parent | `Alt+Arrow Up` | `Alt+Arrow Up` |
| Navigate Child / Back | `Alt+Arrow Down` | `Alt+Arrow Down` |
| Exact target (no expansion) | `Alt+Click` | `Alt+Click` |
| Multi-select | `Shift+Click` | `Shift+Click` |

## Installation

1. Clone this repo
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select this folder
5. Pin the extension from the toolbar for quick access

## Usage

1. Click the VibeExtract icon in your toolbar (auto-enters selection mode)
2. Hover over elements to preview, click to select — small leaves auto-expand to their visible container
3. Use **Alt+Click** if you want the exact element under the cursor instead, **Shift+Click** to add more elements, or **Alt+Arrows** / scroll wheel to walk up and back down the DOM tree
4. Press **Export** or hit the export shortcut
5. A new tab opens with Preview, HTML, TOON views, and a Diagnostics panel showing what got captured vs. dropped
6. Pick your format and download — the file path is copied to your clipboard automatically

### Full Page Workflow

Hit `Cmd+Shift+X` / `Ctrl+Shift+X` to grab the entire page in one keystroke. The export tab opens immediately.

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
| `clipboardWrite` | Auto-copy saved file paths to clipboard |

## License

MIT
