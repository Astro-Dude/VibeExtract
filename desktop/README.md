# VibeExtract Desktop (sibling)

Tauri + Rust desktop app that extracts pixel-perfect HTML/TOON from running desktop applications, mirroring what the browser extension at the repo root does for webpages.

**This folder is a sibling project.** The existing files at the repo root (`contentScript.js`, `export.html`, `export.js`, `popup.{html,js}`, `background.js`, `manifest.json`, `scripts/`) are reused **verbatim, read-only**. A CI gate (`git diff --exit-code -- :!desktop/`) prevents accidental modification.

## What's here

```
desktop/
├── core/                  Shared library — AX picker, CDP injector, screenshot,
│                          NIB / asar / XAML extractors, strategy dispatcher.
├── app/                   Tauri 2 app — the real product.
│   ├── dist/index.html        Frontend (vanilla HTML/JS)
│   └── src-tauri/             Tauri Rust backend (uses `core/`)
├── spike/                 Phase 0 standalone CDP demo (extracts via CDP only)
├── picker-macos/          Phase 1a standalone AX hit-test demo
├── combo/                 Phase 2-lite standalone AX + CDP demo
└── native-extract/        Phase 2-full standalone native-app demo
```

## Strategy ladder (auto-dispatched)

When you capture an element, the dispatcher tries strategies in this order and uses the first one that succeeds:

| Rank | Strategy | When | Fidelity |
|---|---|---|---|
| 1 | `.asar` extraction | Electron with bundled web assets | Source-level (full code recovery — TODO: element matching) |
| 2 | CDP injection | Electron with `--remote-debugging-port` | Pixel-perfect (`getComputedStyle`) |
| 3 | .NET XAML decomp | WPF / WinUI / WinForms + `ilspycmd` installed | Source-level styles |
| 4 | macOS bundle resources | AppKit app — NIB + Info.plist + Assets.car | Partial source (NIB hierarchy + sampled colors) |
| 5 | Qt resource extraction | Qt apps with retained `.qss` | Partial source (TODO) |
| 6 | AX/UIA + pixel sampling | Any app with accessibility | Structure-perfect + sampled colors + screenshot |
| 7 | Screenshot-only | Opaque surfaces (games, canvas) | Visual only |

## Running the Tauri app

```bash
# Build once
cd desktop/app/src-tauri
cargo build --release

# Run it
./target/release/vibe-extract-desktop
```

The first time the app launches you must grant **Accessibility permission** in System Settings → Privacy & Security → Accessibility (the app shows a banner with a button that opens that pane directly). Then:

- Click "📸 Capture at cursor" in the sidebar, **or**
- Press the global hotkey **Cmd+Opt+P** from anywhere on screen

The cursor's current screen position is hit-tested via the macOS Accessibility API. The dispatcher detects what kind of app is under it (Electron / .NET / Qt / AppKit / Win32) and routes to the highest-fidelity extractor available. Output is rendered in the app's main pane with four tabs: **Preview** (the actual HTML rendered in an iframe), **HTML**, **TOON**, **Diagnostics**.

Captures auto-save to `~/Documents/VibeExtract Captures/`. Use the **Save HTML** / **Save TOON** buttons in the result header to drop a timestamped file there explicitly.

## Standalone CLI demos (older slices, kept for diagnostics)

All four CLIs still work and are useful when something in the Tauri app doesn't behave:

```bash
# Phase 0 — CDP only, against a Chrome window
cd desktop/spike
cargo run --release -- --port 9222 --auto-pick "header"

# Phase 1a — show AX info for whatever's under the cursor
cd desktop/picker-macos
cargo run --release

# Phase 2-lite — AX picker + CDP injection (Electron apps with debug port)
cd desktop/combo
cargo run --release -- --port 9222 --cursor-screen X,Y

# Phase 2-full — Native macOS extractor (any AppKit app, no CDP needed)
cd desktop/native-extract
cargo run --release -- --cursor-screen X,Y
```

## Verified outputs

- **Calculator (native AppKit)** — all 21 buttons captured with exact bounds, AX identifiers (#One, #Two, ..., #Equals), and sampled colors (#ff9200 for equals, #474749 for digits). [Phase 2-full]
- **github.com in Chrome (web)** — hero section captured with exact 64px Mona Sans, all class-deduplicated styles, full structure tree. [Phase 0 / Phase 2-lite]

## What's still TODO

| Phase | Status | Notes |
|---|---|---|
| Phase 5 — Packaging (.dmg / .msi) | Pending | Requires your code-signing cert. `cd desktop/app/src-tauri && cargo tauri build` produces an unsigned .app you can run locally. |
| `.asar` element matching | Skeleton only | Parses header but doesn't yet match a live-picked element to its source DOM in a headless renderer. Falls through to CDP / AX. |
| .NET XAML cascade resolver | Skeleton only | `ilspycmd` integration ready, but the `Style.BasedOn` resolver isn't wired. |
| Qt resource extraction | Not implemented | Stub only. |
| Windows UIA picker | Stub only | Code structure compiles on Windows but `pick()` returns an error. Phase 3 is its own milestone. |
| Live overlay window | Not implemented | The picker has no on-screen highlight while hovering. Capture works without it; this is pure polish. |

## Building for distribution

```bash
# Install the Tauri CLI once
cargo install tauri-cli --version "^2"

# From desktop/app:
cd desktop/app
cargo tauri build
# → produces desktop/app/src-tauri/target/release/bundle/macos/VibeExtract Desktop.app
# → and desktop/app/src-tauri/target/release/bundle/dmg/VibeExtract Desktop_0.1.0_aarch64.dmg
```

For signing, set the `APPLE_SIGNING_IDENTITY` env var to your Developer ID Application certificate before running `tauri build`.

## Non-modification guarantee

```bash
git diff --exit-code -- ':!desktop/'
```

Returns clean — the existing browser extension at the repo root is byte-identical.
