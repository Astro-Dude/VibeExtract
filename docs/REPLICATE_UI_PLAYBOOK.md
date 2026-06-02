# Automated UI Replication — Playbook

Turn a running macOS app's UI into self-verified, plain **HTML + CSS** with Claude
in the driver's seat. VibeExtract stops being a one-shot image extractor and
instead exposes its native inspection as **MCP tools** that Claude composes into a
closed perceive → generate → render → verify loop.

```
                 ┌──────────────────── Claude (the agent) ────────────────────┐
                 │                                                             │
   vibe-extract  │  check_ax_permission ─ frontmost_app/list_windows           │
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
   vibe-extract  │       ▼                                                     │
                 │  compare_images(native_path, replica_path) ──► score + diff │
                 │       │                                                     │
                 │       └─ score < 0.92 ? fix CSS, re-render, re-diff ◄───────┘
                 └──────────── stop at score ≥ 0.92 / 6 iters / no-improvement ─┘
```

The agent loop is defined in the **`replicate-ui`** skill
(`.claude/skills/replicate-ui/SKILL.md`); run it with `/replicate-ui`.

## Architecture

- **`vibe-extract` MCP server** — embedded in the VibeExtract Tauri app
  (`desktop/app/src-tauri/src/mcp/`). rmcp Streamable-HTTP on `127.0.0.1:<port>`
  (default 8765), nested at `/mcp`, lifecycle tied to the app (Start/Stop from the
  app UI). Thin wrapper over `vibe-extract-core`; AX work runs in `spawn_blocking`
  so the non-`Send` `AXUIElementRef` never crosses an `.await`.
- **`playwright` MCP server** — Microsoft's official `@playwright/mcp`, launched
  via `npx`. Renders the generated `file://` HTML and screenshots it.
- **Image diff** — pure-Rust SSIM/MAE + heatmap in `vibe-extract-core::image_diff`
  (reuses the `image` crate). Resizes both inputs to a common canvas so device-px
  native shots compare cleanly against CSS-px replica renders.

## Tool reference (`vibe-extract`)

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

## Semantic, interactive markup (role → HTML element)

A replica must not be one flat image or a wall of `<div>`s — **every control is an
individual, real, focusable element**, chosen by its accessibility **role**. This is
**platform-agnostic**: one shared map serves AX-sourced (desktop) *and* DOM-sourced
(Electron) replicas — never special-case per app.

- **`.replicate-ui/_shared/role-map.json`** — the single source of truth, keyed by
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

- **`.replicate-ui/_shared/interactive.css`** — inlined by every generator. An
  element/role-based reset (no UA chrome on `<button>`/`<input>`) so wrapping a sprite
  in a real control is a **pixel no-op**, plus `cursor`/`:hover`/`:active`/`:focus-visible`
  and `[aria-pressed=true]`. **No JS** (static clone): set `aria-selected`/`aria-pressed`
  at build time.

Reference implementations: `.replicate-ui/excel/build.py` (AX → role-driven `<button>`s,
sprite inside), `.replicate-ui/slack/build.mjs` (DOM containers → `<button>` /
`role="tab"`, real SVG inside), and `.replicate-ui/acrobat/build.py` (AX-opaque native →
screenshot-only: roles inferred visually, bounds pixel-measured, glyphs + illustration
sliced as sprites, real on-disk font `@font-face`-d). All three consume the same
`_shared/` map + css — the role→element layer is identical whether the role comes from the
AX tree, the DOM, or visual inference.

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

Reference models (all nest + flow with the same shared map): **Slack `build.mjs`** (DOM-sourced),
**Acrobat `build.py`** (screenshot-sourced, AX-opaque), and **Excel `build.py`** (AX-sourced, the
densest — ~120 controls in 9 ribbon groups; `0.97` absolute → **`0.957`** in flow). Excel uses a
tiny recursive renderer that turns each container's child x/y deltas into flow `margin-left/top`
(reproducing exact positions with zero absolute), and is the canonical example of nested ribbon
groups (`<section class="group …">` → row/col of rows) and the one sanctioned overlay (the A1
cell-selection box inside `position:relative .gridcells`). *Two gotchas it surfaced:* a split
menu-button's icon+caret must be wrapped in an `inline-flex` span or they stack vertically inside a
flex-**column** group; and never reuse a CSS class name across regions (the ribbon `…group cells`
collided with the grid `.cells` block → renamed to `.gridcells`). *Follow-ups not yet converted:*
Slack's 4 remaining topbar absolute anchors; `postman/` has an `index.html` but no build script.

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
   claude mcp add --transport http vibe-extract http://127.0.0.1:8765/mcp
   ```
5. **Install Playwright's browser** once (avoids a hang on first run):
   ```
   npx playwright install chromium
   ```
6. **Verify:** `claude mcp list` shows both `vibe-extract` and `playwright`
   connected. Then run `/replicate-ui`.

## Loop policy (defaults)

- Pass threshold: **SSIM-style score ≥ 0.92**.
- Max **6 iterations** per component; stop early if two consecutive iterations gain
  **< 0.005**.
- Decompose the window into top-level AX regions, verify each against its native
  crop, then compose and verify the whole window.

## Troubleshooting

- **`vibe-extract` won't connect** — the app isn't running, or the server is
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
  content 0.98, whole window 0.96). `.replicate-ui/acrobat/build.py` is the reference for
  this case — same shared `_shared/role-map.json` machinery, roles inferred visually.
- **Low `compare_images` score on a good replica** — you probably rendered at
  device pixels; render at **point** size and let the diff resize.
- **Playwright hangs on first run** — run `npx playwright install chromium`.
