# Automated UI Replication — Playbook

Turn a running macOS app's UI into self-verified, plain **HTML + CSS** with Claude
in the driver's seat. VibeExtract stops being a one-shot image extractor and
instead exposes its native inspection as **MCP tools** that Claude composes into a
closed perceive → generate → render → verify loop.

```
                 ┌──────────────────── Claude (the agent) ────────────────────┐
                 │                                                             │
   echo  │  check_ax_permission ─ frontmost_app/list_windows           │
   (embedded in  │       │                                                     │
    the Tauri    │       ▼                                                     │
    app, HTTP)   │  ax_tree ──► component inventory (roles + bounds + values)  │
                 │       │                                                     │
                 │       ▼                                                     │
                 │  screenshot_region/_window ──► native reference PNGs (paths)│
                 │       │                                                     │
                 │       ▼                                                     │
                 │  write plain HTML+CSS  ◄── sample_color / color_palette     │
                 │       │                     extract_component (head-start)  │
   playwright    │       ▼                                                     │
   (npx)         │  browser_resize → browser_navigate(file://) →               │
                 │  browser_take_screenshot ──► replica PNG (path)             │
                 │       │                                                     │
   echo  │       ▼                                                     │
                 │  compare_images(native_path, replica_path) ──► score + diff │
                 │       │                                                     │
                 │       └─ score < 0.92 ? fix CSS, re-render, re-diff ◄───────┘
                 └──────────── stop at score ≥ 0.92 / 6 iters / no-improvement ─┘
```

The agent loop is defined in the **`replicate-ui`** skill
(`.claude/skills/replicate-ui/SKILL.md`); run it with `/replicate-ui`.

## Architecture

- **`echo` MCP server** — embedded in the VibeExtract Tauri app
  (`desktop/app/src-tauri/src/mcp/`). rmcp Streamable-HTTP on `127.0.0.1:<port>`
  (default 8765), nested at `/mcp`, lifecycle tied to the app (Start/Stop from the
  app UI). Thin wrapper over `vibe-extract-core`; AX work runs in `spawn_blocking`
  so the non-`Send` `AXUIElementRef` never crosses an `.await`.
- **`playwright` MCP server** — Microsoft's official `@playwright/mcp`, launched
  via `npx`. Renders the generated `file://` HTML and screenshots it.
- **Image diff** — pure-Rust SSIM/MAE + heatmap in `vibe-extract-core::image_diff`
  (reuses the `image` crate). Resizes both inputs to a common canvas so device-px
  native shots compare cleanly against CSS-px replica renders.
- **Distribution & layout (important).** A dev gets only two things: the **app** (the MCP
  server; `contentScript.js`/`assetHarvester.js` are embedded into it at build time) and the
  **`/replicate-ui` skill**. The skill is **self-contained**: the *only* shared code is its
  bundled `_shared/` toolkit — `role-map.json`, `markup.py` (role→HTML), `interactive.css`,
  `sprite.py` + `cache.py` (sprite slicing/dedup + reuse cache), `gridtext.py` + `vision_ocr.swift`
  (grid labels). **There is no per-app code in the product.** The method (harvest → inventory →
  generate → verify) is identical for every app; for one extraction you write the HTML directly or
  a single throwaway generator that imports `_shared/`. Everything an extraction produces lives in
  **`.replicate-ui/<app>/`** in the working dir — **gitignored, regenerable scratch; deleting it
  loses nothing but caching speed.** The per-app folders in *this* repo (`excel/`, `acrobat/`,
  `slack/`, …) are **local dev examples** of that scratch — not shipped, not required, not the model.

## Tool reference (`echo`)

| Tool | Params | Returns |
|---|---|---|
| `check_ax_permission` | — | `{ trusted }` |
| `request_ax_permission` | `{ prompt? }` | `{ trusted }` (+ opens Settings) |
| `frontmost_app` | — | `{ pid, app_path, name }` |
| `list_windows` | `{ pid? }` | `{ windows: [{ pid, app_name, title, bounds, window_id, layer }] }` |
| `ax_tree` | `{ pid, max_depth?=12, window_index? }` | AX `Node` tree (role/name/value/bounds/children) |
| `ax_node_at_point` | `{ x, y, pid? }` | `PickedElement` |
| `ax_subtree_at_point` | `{ x, y, max_depth?=12 }` | `Node` |
| `screenshot_region` | `{ x, y, w, h }` (points) | image + `{ px_w, px_h, point_w, point_h, scale, path }` |
| `screenshot_window` | `{ pid, window_index? }` | image + dims + `path` |
| `sample_color` | `{ x, y }` (points) | `{ rgb, hex }` |
| `color_palette` | `{ pid, max_depth?=12 }` | `{ palette_hex, palette_rgb }` |
| `relaunch_with_debug_port` | `{ bundle_id, display_name, confirm }` | `{ port, cdp_url }` — **destructive, needs `confirm:true`** |
| `extract_component` | `{ x, y, pid?, skip_relaunch? }` | `CaptureResult { strategy, fidelity, toon, html, ... }` (+ screenshot) |
| `extract_assets` | `{ target_index?=0, out_subdir?="assets" }` | `{ assets_dir, fonts[{family,weight,style,file}], icons[{className,codepoint,label}], svgIcons (in manifest), images[{label,file,rect_points}] }` |
| `compare_images` | `{ a_path?\|a_png_b64?, b_path?\|b_png_b64?, threshold?=0.92 }` | `{ score, method, mismatch_fraction, pass, ... }` + diff heatmap |

### `extract_assets` — pixel-perfect real fonts/icons/images (Electron, CDP)

> **Assets are mandatory, never hand-drawn.** `extract_assets` runs on **every** `/replicate-ui`
> run (skip only when the per-app cache already has them). NEVER hand-draw, approximate, or
> substitute an icon/image/avatar/font — every one must be a harvested asset, a cached asset, or a
> pixel-crop of the real element. If a *specific* icon isn't in the harvest, get it exactly: crop
> its `screenshot_region` (transparent-key the bg) or use its icon-font codepoint + the harvested
> woff2 — cropping a real glyph always beats drawing one. The bar is **exact assets on the first
> attempt**: the dev should never have to point out that an icon or colour is wrong. (Likewise,
> `sample_color` backgrounds at several points — a title bar / header / body can be different
> shades; don't assume one flat fill.)
> **Icons specifically obey the 🔒 ICON LAW (see "Config-driven ribbons" below): never guess a basename,
> never reuse a prior component's pick on faith, verify EVERY icon in Chromium vs its native crop
> (qlmanage blanks `_kd` glyphs), screenshot only when config+pool are exhausted.**

For a true pixel match you need the app's **actual** assets, not hand-drawn
approximations. `extract_assets` drives CDP (`Runtime.evaluate` + `Page.captureScreenshot`)
against a running Electron app (launched with `--remote-debugging-port`; auto-discovered
on 9220–9230 — use `relaunch_with_debug_port` if absent) and harvests, into
`<out>/<subdir>/{fonts,img}` + an `assets/manifest.json`:

- **fonts** — every `@font-face` woff2/woff (icon fonts *and* text fonts), fetched
  same-origin in-page → bytes saved.
- **icons** — `className → codepoint` for icon-**font** glyphs (with a11y `label`).
- **svgIcons** — when the app renders icons as **inline SVG** (modern Slack), the
  exact `<svg>` markup written to `assets/icons/<name>.svg` (named by `data-qa`) + its
  computed `color` (icons are `fill="currentColor"`).
- **images** — visible `<img>`/background images (avatars, uploads, logos) saved as
  PNGs: read via credentialed in-page `fetch` when CORS allows, otherwise filled by a
  `Page.captureScreenshot` **clip** of the element's rect (immune to auth/CORS; works
  off-screen). `rect_points` = CSS px = points, mapping 1:1 to the replica.

Implementation: `assetHarvester.js` (repo root, embedded in the app like
`contentScript.js`) + `cdp::harvest_assets` (`desktop/core/src/cdp.rs`). Rebuild the
app and restart the MCP server after changing either.

`@playwright/mcp` provides `browser_navigate`, `browser_resize`,
`browser_take_screenshot`, etc.

## Config-driven ribbons (WPS / Kingsoft / Office-style) — the #1 icon-failure fix

For native ribbon apps that ship an XML ribbon definition (WPS Office: PDF/Sheets/Writer/Presentation),
the recurring failure is **guessing icon names** (or trusting the silhouette score on tiny dark glyphs)
and shipping the wrong glyph — even though the app ships the **exact command→icon map**. Prose telling
the agent to "read the `.kui`" did not stop it, so use the **mechanical resolver**:

```bash
python3 "<skill-base>/_shared/ribbon_config.py" --app /Applications/wpsoffice.app \
        --module et|wps|wpp|pdf --labels "Full Screen;Zoom;Arrange All;New Window;Split"
# no --labels => dump the whole command→icon table;  --grep <kw> => search it;  --pid <pid> => locate app
```

It scans the app's WHOLE config (the top-level `*ongmani.kui` is just titlebar/file-menu — the ribbon
bindings live in its `<import>`s: `etcommon.kuip`, `commands/<module>/ongmani/CT_<Tab>.kuip`, …), keyed by
`id=`/`ksoCmd=`/`text=` (NOT `name=`), and returns each button's exact `icon=` basename + alternates.
`--module` disambiguates labels shared across modules (et=Sheets, wps=Writer, wpp=Presentation, pdf=PDF).
A few buttons have a UI label ≠ command text (e.g. WPS-Sheets **"Highlight Row & Column" = the *Reading
Layout* command → `reading_mode_kd`**) — use `--grep`/the full dump and match by meaning. Then pull each
basename from the `.rcc` pool, recolour by class (keep accents), and **still confirm every placed glyph
against a fresh native crop** (the map is exact; you confirm colour + placement).

🚫 NEVER hand-pick a name; 🚫 NEVER claim "verified from the .kui" unless the tool produced it.

> ### 🔒 ICON LAW (non-negotiable — dev-flagged, repeat offender)
> This governs **all chrome** (rails, status bar, title bar, panels), not just ribbons — they're in the
> config too (WPS PDF rails/status are in `pdfcommon.kuip`).
> 1. **NEVER guess an icon basename.** It must come from the app config (`ribbon_config.py` / `.kui` /
>    `.kuip`) or a confirmed visual match against the real pool. A plausible name is a guess — banned.
> 2. **NEVER reuse a previous component's / build's / tab's icon pick on faith.** Reuse the METHOD
>    (layout, generator, fonts); re-verify every icon→basename against THIS capture. "Same chrome / unchanged
>    region" is not verification — an inherited `NAME_MAP` ships **real-but-WRONG** glyphs (WPS-PDF rails,
>    status bar, and Extract all shipped wrong this way).
> 3. **Verify EVERY icon individually, in Chromium, none skipped.** `qlmanage` renders themed `_kd` SVGs
>    **blank** (class fills not applied) — that blind spot is how wrong chrome icons shipped unseen. Render
>    each candidate in Chromium (Playwright) beside a **fresh native crop of that exact control** and confirm
>    shape + accent, for every region. Lock confirmed picks in `icon_map.json`.
> 4. **Screenshot-crop is the ONLY fallback, and ONLY after config + pool are exhausted** and the exact
>    icon truly can't be produced (crop the real glyph; never hand-draw). **Guessing a vector name is NEVER
>    a substitute for cropping — if unsure, crop, don't guess.**
> 5. Not "done" until verified by eye vs native. "Looks fine" / "diminishing returns" / "SSIM text-capped"
>    / "reused from last build" never excuse an unverified icon.

**Chrome ≠ document:** a window's vertical scrollbar / right tool-rail / status dock is **chrome** — pin
it as its own element at the window edge; do NOT bake it into the document-content crop, or it floats as a
stray vertical icon-bar over the sheet (a flagged glitch). Crop the document up to the rail; place the rail
(or its reconstruction) absolutely at `right:0`. Inline-size content `<img width=.. height=..>` so the
in-app Preview can't stretch it.

## Semantic, interactive markup (role → HTML element)

A replica must not be one flat image or a wall of `<div>`s — **every control is an
individual, real, focusable element**, chosen by its accessibility **role**. This is
**platform-agnostic**: one shared map serves AX-sourced (desktop) *and* DOM-sourced
(Electron) replicas — never special-case per app.

- **`_shared/role-map.json`** — the single source of truth, keyed by
  macOS **AX roles** and the equivalent **ARIA/DOM roles**. Each build script picks the
  tag by the source node's role and fills it with the captured content (sprite icon,
  inline SVG, text, value):

  | role | element |
  |---|---|
  | `AXButton` / `button` | `<button>` |
  | `AXMenuButton` | `<button aria-haspopup="menu">` |
  | `AXCheckBox` (toggle) | `<button aria-pressed="…">` |
  | radio in a tab group / `tab` | `<button role="tab" aria-selected="…">` |
  | `AXRadioButton` | `<button role="radio">` |
  | `AXComboBox` / `combobox` | `<div role="combobox" tabindex="0">` + `<input>` |
  | `AXTextField` (`AXSearchField`) | `<input type="text|search">` |
  | `AXTextArea` | `<input type="text">` |
  | `AXSlider` / `slider` | `<div role="slider" tabindex="0">` |
  | `AXStaticText` | `<span>` ·  `AXImage` | `<img>` |

  The proprietary **icon artwork** (sprite PNG for AX apps, inline SVG for Electron)
  goes **inside** the real control — the `<button>` is the semantic/interactive wrapper.

- **Split buttons** (a `AXMenuButton`/anything with a dropdown chevron "v"): the action
  and the caret are **separate components** — a plain `<button>` for the icon/action plus
  its own `<button aria-haspopup="menu">` for the "v" (mirroring real Office:
  `X` + `X Show More Options`). Never fuse an icon and its dropdown chevron into one
  element. Combos likewise = `<input>` value + a separate caret.
  - **Don't hardcode which buttons have a caret** (and never exclude by region/app).
    Detect it: the caret is a small glyph on the **right edge** set off from the icon by
    a clear background **gap** (see `detect_caret()` in `excel/build.py` — it reads the
    sprite pixels). This splits `Undo`/`Borders`/… but correctly leaves a single-glyph
    menu opener like the `⋯` overflow button whole (no gap → no split). For tall split
    buttons whose label fills the columns, fall back to a right-edge caret overlay.

- **`_shared/interactive.css`** — inlined by every generator. An
  element/role-based reset (no UA chrome on `<button>`/`<input>`) so wrapping a sprite
  in a real control is a **pixel no-op**, plus `cursor`/`:hover`/`:active`/`:focus-visible`
  and `[aria-pressed=true]`. **No JS** (static clone): set `aria-selected`/`aria-pressed`
  at build time.

Worked examples (local dev scratch in this repo — **gitignored, not shipped, not required**; they
just illustrate the method): `excel/build.py` (AX → role-driven `<button>`s, sprite inside),
`slack/build.mjs` (DOM containers → `<button>` / `role="tab"`, real SVG inside), and
`acrobat/build.py` (AX-opaque native → screenshot-only: roles inferred visually, bounds
pixel-measured, glyphs + illustration sliced as sprites, real on-disk font `@font-face`-d). All
three consume the same `_shared/` map + css — the role→element layer is identical whether the role
comes from the AX tree, the DOM, or visual inference. For a new app you don't copy these; you apply
the method, calling `_shared/markup.py` (role→tag) + `_shared/sprite.py` (slice) directly.

## Layout: nested hierarchy + normal flow (not a flat `position:absolute` canvas)

A replica's DOM must read like hand-written code: a **nested tree of real landmark
containers** (`<header>`/`<nav>`/`<aside>`/`<main>`/`<section>`) laid out with **normal
document flow + flexbox** — *never* a flat pile of `position:absolute` elements off one
`.canvas`. Position children with `display:flex`, `gap`, `margin`, `margin-left:auto`,
`padding`, `flex` ratios — not per-element `left`/`top`. **Reserve `position:absolute`
for genuine overlays pinned inside a `position:relative` parent** (a presence dot on an
avatar corner, an unread badge, a dropdown caret, a focus ring); it is never the primary
layout mechanism.

This holds **even when the source gives pixel bounds** (AX tree or screenshot): translate
those bounds into container `padding`/`gap`/`margin` **once**, computed from the measured
constants, rather than stamping each element at an absolute coordinate. Keeping it
pixel-exact in flow rests on three habits:
- **Anchor each toolbar group by its fixed edge** — left group first, right group pushed
  with `margin-left:auto` + a fixed end-padding; let the intra-group `gap`s fall inward so
  the visually-dominant edge is exact (drift hides on the inner edge).
- **Re-anchor long vertical lists per-section** with an explicit `margin-top` derived from
  the measured centre-Y deltas, so flex rounding resets at each section instead of
  accumulating down a 15-row sidebar.
- **Centre text** with the row container's `align-items:center` + a leaf `line-height:1`
  (font-metric-robust); this removes per-element vertical offset hacks. (A `<button>`'s
  text can still sit ~2–3px off vs a `<span>`; fix per-class if a region diff shows it,
  but try `line-height:1` first — it usually suffices.)

Expect a **small fidelity cost** vs absolute (flow positions text at sub-pixel offsets):
the Acrobat Home replica is 0.965 absolute → **0.956** in flow (content 0.97, sidebar 0.90
— the dense-small-text rasterizer floor). Verify per region with `compare_images` and
nudge `gap`/`margin`/`padding` until each region holds (target ≈0.96, floor ≥0.92).

Worked examples (local dev scratch — gitignored, not shipped; the technique, not the files, is what
transfers): **Slack `build.mjs`** (DOM-sourced), **Acrobat `build.py`** (screenshot-sourced,
AX-opaque), and **Excel `build.py`** (AX-sourced, the densest — ~120 controls in 9 ribbon groups;
`0.97` absolute → **`0.957`** in flow). Excel uses a
tiny recursive renderer that turns each container's child x/y deltas into flow `margin-left/top`
(reproducing exact positions with zero absolute), and is the canonical example of nested ribbon
groups (`<section class="group …">` → row/col of rows) and the one sanctioned overlay (the A1
cell-selection box inside `position:relative .gridcells`). *Two gotchas it surfaced:* a split
menu-button's icon+caret must be wrapped in an `inline-flex` span or they stack vertically inside a
flex-**column** group; and never reuse a CSS class name across regions (the ribbon `…group cells`
collided with the grid `.cells` block → renamed to `.gridcells`). *Follow-ups not yet converted:*
Slack's 4 remaining topbar absolute anchors; `postman/` has an `index.html` but no build script.

## Grid labels → real text (don't bake them into a sprite) — `_shared/gridtext.py`

When a region is a **grid of labels baked into one image** (a spreadsheet's column letters /
row numbers, a timeline's dates, …), turn it into **real, individual text cells** — never a
sprite. The mechanism is shared + platform-agnostic (`_shared/gridtext.py`,
used by Excel's headers; available to every replica). **Nothing is hardcoded** — range, cell
sizes *and* label values are derived from the capture each run, so a scrolled/resized sheet
adapts with no code change:

- **Geometry** — `detect_boundaries()` reads the real gridlines from the **cell area** (gray
  lines on white) along a centre probe → exact cell offsets/sizes. The range is *detected*,
  never a hardcoded count.
- **Text — the hybrid AX → OCR → repair** (`header_labels(…, kind)`):
  1. **AX** labels if the app exposes them (`ax_labels=`) — truly data-driven.
  2. else **OCR** each detected cell via macOS **Vision** (`_shared/vision_ocr.swift`, compiled
     once + cached; no install). OCR the cell with invert→autocontrast→upscale→pad (single
     isolated glyphs are OCR's worst case, so prep matters).
  3. **sequence-repair** (`kind="alpha"|"numeric"`): OCR establishes the **start** (so scrolled
     sheets stay correct); the sequence rule then regenerates the arithmetic run from that start,
     fixing OCR noise (I↔1, O↔0) and filling missed cells. `kind` is the only per-region hint —
     not the values or the range.
- Render each cell as a real element (`<div class="colhdr">A</div>` …), sized from the
  detection, coloured from `sample()`, with the **selected** column/row highlight *detected*
  (the header cell whose bg is lighter than the band) — not hardcoded to A1.

**Cost:** browser-rendered text can't pixel-match the native sprite, so a dense label band loses
a little SSIM (Excel headers: 0.957 with the sprite → **~0.918** as real text) — the deliberate
"real text over image" trade-off. Verify per band; it's the expected floor, not a bug.

## Incremental reuse — similar pages of an app (`_shared/cache.py`)

A real tool has many pages, and pages of the *same* app share their entire chrome — title bar,
sidebar, toolbar, fonts, icon set. **Pay the full cost once per app; be fast on every page
after.** That's the point of the per-app cache under `.replicate-ui/<app>/`. At the start of a
run (SKILL step **2c**), call:

```
python3 _shared/cache.py <app> [win_w win_h]
```

It reports — and the skill **reuses** — three app-stable artifact classes plus the prior replica:

| Artifact | Where | Why it's stable across pages | Reuse action |
|---|---|---|---|
| **Electron assets** (fonts, icon-svgs, images) | `assets/manifest.json` | Same app = same icon set + fonts | **Skip** `relaunch_with_debug_port` + `extract_assets` — the slowest, most disruptive step (it quits the app). Reference the existing `assets/` verbatim. |
| **Bundle icon pool** (qt/appkit/loose apps) | `pool/manifest.json` | Icons come from the app BUNDLE, not screenshots | `extract_pool(app_path, cache_dir="pool")` fingerprints the bundle (path+version+mtimes) and **skips re-extraction** while it matches; any app update re-extracts. |
| **Confirmed icon picks** | `icon_map.json` (`{resource,confirmed,crop_hash}`) | The same control uses the same resource | `icon_match.lock_decision` per control → `reuse` (capture identical) / `reverify` (gate the placed icon against THIS page's capture: `icon_gate.py … --only <list> --update-locks icon_map.json`) / `repick` (resource gone). Never reuse on faith. |
| **Grid header labels** (A..Z / 1..N) | `capture/headers_cache.json` | Positionally fixed for a window size | `gridtext.py` reuses it automatically — no re-OCR. |
| **Ribbon/toolbar sprites** (AX apps) | `cache/sprites/<hash>.png` | The toolbar doesn't change | Content-addressed (`SpriteCache`): an identical icon re-slices to a cache **hit**, sharing one file. |
| **Prior verified replica** | `index.html` | A similar page is a small delta | **Start from it** — copy, then diff-edit only the changed regions and re-verify just those. |

**The big win is not the bytes — it's the iterations.** Generating a page from scratch is
~6 verify loops per component; starting from a verified sibling page and editing only what
differs is often one or two. And skipping the asset harvest avoids the one step that quits and
reopens the user's app. Net: page 1 of an app is full cost; pages 2..N are a fraction.

**Slicing sprites for an AX / screenshot-only app** — use the toolkit's `sprite.SpriteSlicer`
(it wraps `cache.SpriteCache`, so identical icons across pages content-address to one file). Put
`_shared/` on `sys.path` (the skill knows its base dir), then:

```python
import sys; sys.path.insert(0, "<skill-base>/_shared")
import markup                                   # role -> semantic tag
from sprite import SpriteSlicer                 # crop real pixels -> deduped PNG
sl = SpriteSlicer("capture/window.png", out_root=".replicate-ui/<app>", scale=scale, origin=win_origin)
rel = sl.slice("bold", x, y, w, h)              # -> "cache/sprites/<hash>.png"; identical crop = same file
html = markup.el("AXButton", inner=f'<img src="{rel}">', cls="iconbtn", extra_attrs={"aria-label": "Bold"})
...
print(sl.stats())                               # {"hits":.., "misses":.., "reuse_pct":..}
```

**General, never per-app:** the cache keys off the working-dir name and the manifests the existing
tools already write. No app names, ranges, or counts are hardcoded — a brand-new app simply
reports "first page, full cost" and populates the cache as it goes.

## The coordinate / scale contract (read this)

- AX bounds and all screenshot inputs are **points**, top-left origin.
- macOS `screencapture` outputs **device pixels** (Retina ≈ 2× points). Every
  `screenshot_*` result reports `px_w`/`px_h`/`scale = px_w / point_w`.
- **Render the replica at point size** (CSS px = `point_w × point_h`).
  `compare_images` resizes both sides to a common canvas, so you never hand-match
  device pixels. Rendering at device px is the most common cause of a low score on
  an otherwise-correct replica.
- **This contract governs render *size*, not positioning *strategy*.** Render at point
  size, but lay elements out with the nested-hierarchy + normal-flow model above — turn
  measured point bounds into container spacing, don't reuse them as absolute coordinates.

## Setup / onboarding

1. **Build & run the app**
   ```
   cargo build --manifest-path desktop/app/src-tauri/Cargo.toml
   # then launch it (e.g. cargo tauri dev, or the built bundle)
   ```
2. **Grant macOS permissions** to VibeExtract: System Settings → Privacy &
   Security → **Accessibility** *and* **Screen Recording**. (Accessibility =
   reading AX trees; Screen Recording = `screencapture` returns real pixels, not
   black.)
3. **Start the MCP server** from the app: sidebar → *MCP Server (for Claude)* →
   **Start MCP server**. Copy the connect command (it shows the live URL/port).
4. **Register both servers** with Claude Code — either paste `.mcp.json` (adjust
   the port to match the live URL and set `--output-dir` to an absolute path), or:
   ```
   claude mcp add --transport http echo http://127.0.0.1:8765/mcp
   ```
5. **Install Playwright's browser** once (avoids a hang on first run):
   ```
   npx playwright install chromium
   ```
6. **Verify:** `claude mcp list` shows both `echo` and `playwright`
   connected. Then run `/replicate-ui`.

## Loop policy (defaults)

- Pass threshold: **SSIM-style score ≥ 0.92**.
- Max **6 iterations** per component; stop early if two consecutive iterations gain
  **< 0.005**.
- Decompose the window into top-level AX regions, verify each against its native
  crop, then compose and verify the whole window.

## Troubleshooting

- **`echo` won't connect** — the app isn't running, or the server is
  stopped. Open the app, click *Start MCP server*, confirm the URL matches your
  `claude mcp add` / `.mcp.json`. The port may differ from 8765 if it was busy —
  the app UI shows the live one.
- **Screenshots are black** — grant **Screen Recording** to the app.
- **`ax_tree` is nearly empty for an Electron app** (Slack/VS Code/Discord) — AX is
  shallow until the app is woken; use `extract_component` (CDP head-start) or
  `relaunch_with_debug_port { confirm: true }`.
- **`ax_tree` returns a window with NO children AND `ax_node_at_point` finds nothing**
  (Adobe Acrobat Reader's Home and other CEF/custom-drawn *native* apps) — the surface is
  genuinely **AX-opaque** and it is *not* Electron (no CDP port to harvest). First rule out
  the **inactive-Space gotcha** (empty AX because the app is on another Space): `open -a`
  the app to bring its window to the active Space, then re-capture (`screenshot_region`
  works even when `screenshot_window` trips during a Space transition). If AX is still
  empty, fall back to a **screenshot-only / sprite** replica (a third case beyond AX-rich
  and Electron): measure every control's bounds by **pixel analysis** of `capture/window.png`,
  slice the proprietary glyphs + illustration as sprites, render text **live**, and
  **harvest the app's real font from disk** — e.g. Acrobat ships *Adobe Clean UX* at
  `/Library/Application Support/Adobe/Acrobat/DC/WebResources/Resource1/app1/fonts/*.otf`;
  copy the weights you need into the replica and `@font-face` them. The real font alone
  turns text-width "doubling" in dense regions into a match (Acrobat sidebar 0.84 → 0.87,
  content 0.98, whole window 0.96). The `acrobat/` example (dev scratch) shows this case —
  same shared `_shared/role-map.json` machinery, roles inferred visually.
- **Low `compare_images` score on a good replica** — you probably rendered at
  device pixels; render at **point** size and let the diff resize.
- **Playwright hangs on first run** — run `npx playwright install chromium`.

## Native AppKit apps: clean icons from `Assets.car` (Office ribbons — the right way)

A native AppKit app (Office, Finder, Mail, System Settings) is the **fourth case** (beyond AX-rich
DOM, Electron/CDP, and AX-opaque screenshot-only). Its toolbar/ribbon icons live in the app's
**compiled asset catalog** `Assets.car`. Extract them CLEAN + transparent instead of cropping
screenshot sprites (which bake in the background, can't scale, and — if mis-sized — break the layout).
Tools: `_shared/catalog_extract.m` (CoreUI `Assets.car` → transparent PNGs) + `_shared/native_icons.py`.

Worked pipeline (proven on Excel **Insert** and Word **Layout** ribbons):
1. **Inventory from AX** — every control's `name`, `role`, `bounds`. The role is authoritative for
   chevrons: `AXMenuButton` → dropdown caret; `AXButton`/`AXCheckBox` → none (`native_icons.caret_for`).
   `AXIncrementor` → a stepper (label + value box + arrows + small inline indicator icon).
2. **Extract the pool** — `find_catalogs(app_path)` (Office ribbon icons are in the ~22 MB
   `mso40ui.framework/.../Assets.car`), `build_pool(car, out)`, `load_pool(out, "normal_dark")` for a
   dark UI (`"normal"` for light) → `{ base-name → largest-rendition png }`.
3. **Match by NAME** — `name_match(ax_name, pool, extra=[known catalog name])`: exact → keyword-narrow
   → visual-confirm. AX name → catalog base, e.g. Bold→`ic_fluent_text_bold`, Columns→`TextColumnTwo`,
   Margins→`UxGalPageMargins`, Share glyph→`ic_fluent_share`. **Blind visual search over thousands of
   icons picks the wrong one** (it once chose a "BriefCase" blob and the spreadsheet-columns glyph).
   No confident match → **screenshot-crop fallback** (`key_bg(crop, bg)` → transparent).
4. **Place at the MEASURED glyph box** — `measure_glyph_box(crop, button_box, kind)` gives each icon's
   exact (x,y,w,h) from the native crop. Place the icon there; **never a fixed 32×32 square** (native
   glyphs vary, e.g. a wide ~39×28 Margins icon — a square mis-sizes/shifts the whole row). Use the
   **largest** rendition downscaled = crisp, not thick.
5. **States & chrome** — greyed/disabled controls at ~0.4 opacity; group sub-labels (`AXStaticText`)
   and stepper labels/boxes aligned in columns under their header. **Never hand-draw the Share/accent
   button** — sample its exact fill (Excel green `#3e8745`, Word blue `#3d6ede`) and use the real glyph.
6. **Verify with a STACKED native-over-replica image + per-region crops**, not just the number. Aligned
   icons go **dark** in the heatmap. **SSIM is text-capped** (~0.55–0.75) on label-dense ribbons because
   real-text labels differ from native font AA — that residual red is text, not a layout bug. Judge
   layout by alignment in the stacked view; only declare done once it passes region-by-region.

Reference scratch: `.replicate-ui/excel-insert/build_insert.py`, `.replicate-ui/word-ribbon/build_word.py`
(throwaway generators that import the toolkit — the method, not per-app code).

## Qt / kdesign (`_kd`) icons: recolour BODY vs ACCENT, then a COLOUR-AWARE gate (the WPS lesson)

Qt/Kingsoft `_kd` and `colorXStroke` SVGs split paint across classes: a theme-following **body**
(`kd-color-icon-primary` / `.colorBlackStroke` / `var(--kd-color-icon-primary,#333333)`) and a **named
accent** (`kd-color-icon-blue-primary`, `.colorBlueStroke`). The trap that shipped wrong icons: a
recolour that picks **one colour per icon** and applies it to *every* class — so an accented icon's
document **body** gets painted the accent colour (a fully-blue PDF→Word doc instead of grey-doc + blue
"W"). It's invisible on monochrome icons and only bites accented ones, so it survives until you eyeball
them. Fixes, now baked into the toolkit:

- **`_shared/icon_theme.py` `recolor_designed(svg, body_hex, refine=…)`** — THE canonical recolour, and the
  DEFAULT every build should call. Assigns colour by CLASS ROLE, and the COLOUR SOURCE OF TRUTH is the
  icon's **DESIGNED accent (its named accent CLASS), NOT the screenshot** — so it is correct on the FIRST
  pass with zero dev feedback. Body classes → the **ACTIVE-window** bright grey (`#cfcfcf`); each named-
  accent class → its **DESIGNED VIVID** dark-theme accent (blue `#3d8bf5`, green `#25b06e`, orange `#ef7d12`,
  red `#ec5347`, purple `#9a6cf2`, teal `#18b3a6`, yellow `#f2b324`). **An icon with a named accent class is
  ALWAYS coloured + vivid; no accent class ⇒ monochrome grey.** 🚫 Do NOT take an icon's colour by SAMPLING
  the screenshot: a background/inactive/unfocused window desaturates the WHOLE toolbar (dim body + muted
  accents) and tiny glyphs blend toward grey under AA, so sampling ships dull/grey icons (this is exactly why
  WPS-Sheets Formulas icons shipped grey twice). The capture only REFINES a hue — pass
  `refine={word:(r,g,b)}` from `icon_match.dominant_accent`, and `recolor_designed` IGNORES a dull/grey/
  desaturated sample (`s<0.30` or `v<0.30`), so an inactive-window capture can never flatten or dull a
  designed accent. Disabled tools ⇒ dim the WHOLE button (icon+label opacity), never grey the accent. Render
  the ACTIVE/focused appearance, never the dull inactive-window capture. (`recolor_svg(svg, body_hex,
  accents=…)` remains as the lower-level override `recolor_designed` builds on.) Handles both the raw
  `var(--…,fallback)` and hardcoded `#hex` forms. Call it at BUILD time (recolours every `ic/*.svg` per run).
- **`_shared/icon_match.py` `gate_icon(native_crop, replica_crop)`** — the COLOUR-AWARE gate the
  silhouette-mask scorer (colour-blind) and whole-strip SSIM (alignment-dominated) both miss. Scores
  shape AND samples body+accent on both sides (≤~24/ch, median-of-core so AA doesn't fool it). Locate
  each native glyph by **template-matching the clean replica glyph over a generous window** — a fixed
  geometry box catches label text ("Pic"/"Extr"/"Sc"). Don't stop until every icon matches shape AND
  colour. When a glyph is the wrong RESOURCE (not just mis-coloured), re-match against the pool by eye —
  e.g. WPS "Export to PDF" is the two-loop "P" (`ExportToPDFQat.svg`), not a doc+arrow; "Extract Text"
  is the image-frame + blue "W" (`appcmd_kocrtool_Pic2Word`), not the all-blue extract-from-image glyph.
- **`_shared/icon_gate.py` — THE runnable acceptance gate + Definition of Done.** Icons are where "looks
  fine" repeatedly shipped wrong, so the verdict is a command, not a judgment. The generator emits
  `icon_boxes.json` (`{name:[x,y,w,h]}`) and the build runs the gate as its LAST step (so it can't be
  skipped): `python3 icon_gate.py native.png replica.png icon_boxes.json`. It template-LOCATES each
  native glyph (slides the clean replica glyph — a fixed box catches label text), compares shape +
  body/accent colour, writes a native|replica contact sheet (`_icon_gate.png`), and exits **0** (all
  PASS) / **1** (gross colour FAIL — fix + rebuild) / **2** (some EYEBALL — low-confidence localize /
  thin glyph). It's deliberately conservative — colour metrics on tiny AA'd glyphs are noisy, so it
  hard-fails only GROSS errors (body painted the accent ≈ Δ140) and routes the rest to your eye;
  `recolor_designed` (designed accent primary, capture-independent) is what makes the FIRST render correct —
  the gate confirms, it is NOT the colour source. **DoD: icons are done only at exit 0, or exit 2
  with every EYEBALL tile confirmed identical by eye on the contact sheet. A FAIL or an unreviewed
  EYEBALL is never "done."** (SKILL.md steps 8b + 11.)

Reference scratch: `.replicate-ui/wps/build_tools.py` (recolours via `icon_theme` at build, emits
`icon_boxes.json`, auto-runs `icon_gate.py`), `icon_map_tools.json` (resource + sampled body/accent).
