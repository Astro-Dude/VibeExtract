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

## The coordinate / scale contract (read this)

- AX bounds and all screenshot inputs are **points**, top-left origin.
- macOS `screencapture` outputs **device pixels** (Retina ≈ 2× points). Every
  `screenshot_*` result reports `px_w`/`px_h`/`scale = px_w / point_w`.
- **Render the replica at point size** (CSS px = `point_w × point_h`).
  `compare_images` resizes both sides to a common canvas, so you never hand-match
  device pixels. Rendering at device px is the most common cause of a low score on
  an otherwise-correct replica.

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
- **Low `compare_images` score on a good replica** — you probably rendered at
  device pixels; render at **point** size and let the diff resize.
- **Playwright hangs on first run** — run `npx playwright install chromium`.
