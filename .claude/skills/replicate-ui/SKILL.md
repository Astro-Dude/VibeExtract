---
name: replicate-ui
description: Automatically replicate a running macOS app's UI as plain HTML+CSS, using VibeExtract's MCP tools (AX tree, self-screenshots, visual diff) plus the Playwright MCP to render and self-verify until the replica visually matches. Use when the user wants to clone/recreate a desktop app screen or window as web UI.
---

# Replicate a desktop UI (perceive → generate → verify loop)

You drive a closed loop: inspect a running macOS app via the **`vibe-extract`** MCP
server, generate plain self-contained **HTML+CSS**, render it with the
**`playwright`** MCP, and visually diff the render against the native original —
iterating until they match.

Both MCP servers must be connected (`claude mcp list`). If `vibe-extract` is
missing, tell the user to open the VibeExtract app and click **Start MCP server**,
then `claude mcp add --transport http vibe-extract <url>`. See
`docs/REPLICATE_UI_PLAYBOOK.md` for full setup.

## The golden rule: coordinates & scale
- All AX bounds and screenshot inputs are in **points**, top-left origin.
- Native screenshots come back at **device pixels** (Retina ≈ 2× points). Each
  `screenshot_*` result includes `px_w`, `px_h`, and `scale` (px/point).
- **Render the replica at the component's POINT size** (CSS px = `point_w × point_h`).
  `compare_images` resizes both sides to a common canvas, so you do **not** need to
  match device pixels — just render at point size and let the diff reconcile scale.

## Loop

1. **Preflight.** Call `check_ax_permission`. If not `trusted`, call
   `request_ax_permission` and tell the user to grant VibeExtract under
   System Settings → Privacy → Accessibility **and** Screen Recording
   (`screencapture` needs the latter or shots come back black). Stop until granted.

2. **Target.** `frontmost_app` (or `list_windows`) to get the target `pid` and the
   window `bounds`. Confirm with the user which window if ambiguous.

3. **Inventory.** `ax_tree { pid, window_index: 0 }` → the component tree (roles,
   names, values, per-node `bounds`). This is your structural source of truth — a
   screenshot can't give you roles/labels. For Electron apps the AX tree may be
   shallow; if so, use `extract_component { x, y, pid }` for a high-fidelity
   DOM/CSS head-start (it returns `html`+`toon`), or call
   `relaunch_with_debug_port { bundle_id, display_name, confirm: true }` first
   (this quits & reopens the app — only with the user's OK).

3b. **Harvest real assets (Electron with a debug port).** Icons and images are
   what a hand-built replica can't fake — they're proprietary vectors/photos.
   Call `extract_assets { }` to pull them straight from the live renderer via CDP
   (works even when the app isn't frontmost). It writes files under
   `<out>/assets/{fonts,img}` and returns a manifest:
   - `fonts[]` — every `@font-face` woff2 (icon fonts **and** text fonts, e.g.
     Slack's `Slack-Lato-Quip`), saved locally.
   - `icons[]` — `className → codepoint` for icon-**font** glyphs (apps that use
     an icon font), with each glyph's accessible `label`.
   - `svgIcons[]` — for apps that render icons as **inline SVG** (modern Slack:
     ~50 icons named by `data-qa`, e.g. `home-filled`, `search`, `send-filled`),
     the exact SVG written to `assets/icons/<name>.svg` plus its computed `color`.
   - `images[]` — every visible `<img>`/background (avatars, uploaded files,
     workspace icon) saved to `assets/img/<label>.png`, read in-page when CORS
     allows, else captured pixel-perfect via a `Page.captureScreenshot` clip.
   Map each asset to your replica by its `label`/`name` (icons) and by identity
   (images). Inline SVGs use `fill="currentColor"` — inline them and set the
   wrapper `color` to the captured value; size them with your container's
   `svg{width:Npx}` rule (do **not** force `width:100%`, which blows up unsized
   buttons). Keep text on a calibrated stack (the local text font is identical to
   the system one but can re-drift hand-tuned spacing — verify after swapping).

4. **Reference shots.** `screenshot_window { pid }` for the whole window, and
   `screenshot_region { x,y,w,h }` per component (use each node's `bounds`). Each
   returns an inline image (look at it) **and** a saved `path` (use that for diffing).
   Note the `scale`.

5. **Decompose.** Split the window into its top-level AX regions (title bar,
   sidebar, toolbar, content). Replicate and verify each **independently** against
   its native crop, then compose into one document and verify the whole window.

6. **Generate.** Write plain, self-contained **HTML+CSS** (no framework, no build
   step) to a working dir, sized to the component's **point** dimensions. Use the
   AX inventory for structure/text and the reference shot + `sample_color`/
   `color_palette` for colors, spacing, and fonts. For **icons and images**, drop
   in the real assets from step 3b (inline the harvested SVGs / reference the
   saved PNGs + woff2) rather than hand-drawing — that's the difference between a
   look-alike and a pixel match. A tiny generator script that reads the manifest
   and substitutes assets by name keeps this repeatable.

7. **Render.** Via the `playwright` MCP:
   - `browser_resize { width: point_w, height: point_h }`
   - `browser_navigate { url: "file:///abs/path/to/replica.html" }`
   - `browser_take_screenshot { filename: "replica-<component>.png" }` → note the saved path.

8. **Verify.** `compare_images { a_path: <native crop path>, b_path: <replica path> }`.
   Read `score` (0..1) and look at the returned **diff heatmap** (bright red = where
   they differ).

9. **Iterate.** If `pass` is false (score < 0.92): inspect the heatmap, fix the
   HTML/CSS for the highlighted regions, re-render, re-diff. Stop when:
   - `score ≥ 0.92` (pass), **or**
   - **6 iterations** on this component, **or**
   - two consecutive iterations improve `score` by **< 0.005** (diminishing returns).
   Report the final score per component; never silently accept a low score.

10. **Compose & final-verify.** Assemble verified components into the full page at
    the window's point size, render, and `compare_images` against the
    `screenshot_window` shot. Report the final whole-window score and write the
    final `index.html`.

## vibe-extract tools (reference)
`check_ax_permission`, `request_ax_permission`, `frontmost_app`, `list_windows`,
`ax_tree`, `ax_node_at_point`, `ax_subtree_at_point`, `screenshot_region`,
`screenshot_window`, `sample_color`, `color_palette`, `relaunch_with_debug_port`
(destructive — needs `confirm:true`), `extract_component`, `extract_assets`
(real fonts/icons/images via CDP → local files + manifest), `compare_images`.

## Notes
- Prefer `ax_tree` node `bounds` → `screenshot_region` for pixel-tight crops over
  `screenshot_window` cropping.
- Mask dynamic content (clocks, unread badges) mentally when reading the score; a
  perfect static replica may still show small red regions there.
- If `compare_images` scores low even on a good replica, re-check you rendered at
  **point** size (not device px) — that's the #1 cause.
