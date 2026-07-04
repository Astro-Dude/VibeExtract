---
name: replicate-ui
description: Automatically replicate a running macOS app's UI as plain HTML+CSS, using Echo's MCP tools (AX tree, self-screenshots, visual diff) plus the Playwright MCP to render and self-verify until the replica visually matches. Use when the user wants to clone/recreate a desktop app screen or window as web UI.
---

# Replicate a desktop UI (perceive → generate → verify loop)

You drive a closed loop: inspect a running macOS app via the **`echo`** MCP
server, generate plain self-contained **HTML+CSS**, render it with the
**`playwright`** MCP, and visually diff the render against the native original —
iterating until they match.

Both MCP servers must be connected (`claude mcp list`). If `echo` is
missing, tell the user to open the Echo app and click **Start MCP server**,
then `claude mcp add --transport http echo <url>`. See
`docs/REPLICATE_UI_PLAYBOOK.md` for full setup.

## The toolkit & where things live (read once)
There is **ONE common toolkit, no per-app code.** It ships *inside this skill* at
`_shared/` (the **Base directory for this skill** shown at the top of this prompt) — so it
travels with the skill on any machine, with or without this repo:
- `role-map.json` + `markup.py` — AX/ARIA role → semantic HTML tag/attrs (`markup.role_el`,
  `markup.el`, `markup.attrs_str`); **`markup.el_from_node(node, …)`** builds an element from an AX
  node AND stamps `data-ax-*` (role/name/bounds/id) so the HTML carries the AX tree (step 6).
- `axtree_view.html` — standalone collapsible viewer for an extraction's `ax_tree.json`; copy it into
  the output dir as `ax_tree.html` (step 10).
- `interactive.css` — the button/input reset + hover/focus/active.
- `sprite.py` (`SpriteSlicer`) + `cache.py` (`SpriteCache`) — crop real pixels into deduped
  icon sprites (for AX / screenshot-only apps); `cache.py` is also the reuse-cache CLI.
- `gridtext.py` (+ `vision_ocr.swift`) — baked grid labels → real text (AX→OCR→repair).
- `resource_extract.py` + `icon_match.py` — **THE icon picker (use this first).** `extract_pool(app)`
  pulls the app's FULL real-icon set (qt `.rcc` / appkit `Assets.car` / electron / loose, auto-dispatch);
  `icon_match.match(native_crop, pool, idx, name_prior=…)` then picks each control's icon by **VISUAL
  silhouette match to the native pixels** (colour-invariant; name map only a prior), and `icon_map.json`
  **LOCKS** confirmed picks so re-runs never regress them. This replaces name-only matching for ALL apps
  (name-matching alone whack-a-moles). See step 3b.
- `catalog_extract.m` + `native_icons.py` — AppKit `Assets.car` extractor (the appkit branch of
  `extract_pool`) + `measure_glyph_box`/`trim`/`key_bg`. `native_icons.name_match` is now just a
  name-PRIOR provider for `icon_match`, not the decider.

Reference it **by the skill's base path**, e.g. `python3 "<skill-base>/_shared/cache.py" …`;
below, `_shared/…` is shorthand for that. **There are no app-specific scripts to locate** — the
method (harvest → inventory → generate → verify) is identical for *every* app; for a given
extraction you generate the HTML directly, or write one **thin throwaway generator** into the
output dir that imports this toolkit.

**Outputs are scratch.** Everything you produce for an extraction — the replica `index.html`,
harvested `assets/`, screenshots/captures, sprite `cache/`, and any generator you write — lives
in **`.replicate-ui/<app>/`** in the current working directory. That folder is gitignored and
fully regenerable: **deleting it loses nothing but caching speed.** The only thing that must
persist is the skill (with its `_shared/`).

## THE METHOD — the canonical pipeline for EVERY app (read this first)
One method, every app — Office, WPS, Slack, Finder, Acrobat, Chess, any macOS app. **No per-app code.**
Four pillars, always in this order; each links to its detailed step below. (Index across sessions:
the master memory `[[replicate-ui-method]]`.)

1. **Icons come from the app's OWN install bundle — never screenshots, never hand-drawn.** Locate the
   install dir (`ps -p <pid> -o comm=` / `mdfind` / `/Applications/<App>.app`) and pull its FULL real-icon
   set with `resource_extract.extract_pool(app_path)` (auto-dispatch: Qt `.rcc` / AppKit `Assets.car` /
   Electron inline-SVG / loose). A screenshot crop is a per-icon LAST RESORT, only for a runtime-rendered
   element with no resource file. **For config-driven ribbons (WPS/Kingsoft/Office-style) the app ALSO
   ships the exact command→icon MAP — run `_shared/ribbon_config.py` to read it; never guess icon names
   (the #1 repeated failure).** → step 3b.
2. **The LLM judges every icon and pixel-matches it to the native reference — then locks it.**
   `icon_match.match(native_crop, pool, idx, name_prior=…, keywords=…)` ranks candidates by a
   colour-invariant silhouette score — the native PIXELS decide, the name map only biases. THEN the
   **LLM vision gate is a REQUIRED step**: view the native crop beside the top-k and confirm each pick
   once by eye (shape + accent colours) — the score narrows but doesn't settle the final look (thin /
   accent-only glyphs stay low-confidence). Lock every confirmed pick in `icon_map.json` **via
   `icon_match.confirm_pick` or the gate's `--update-locks` — NEVER a raw `json.dump`** (that clobbered
   maps and never recorded `crop_hash`, so locks silently didn't hold). On later pages/runs, triage each
   entry with `icon_match.lock_decision` → reuse / reverify-via-gate / repick. → step 3b.
   **Icon COLOUR is the icon's DESIGNED accent (its named accent class) rendered at the ACTIVE-window look
   (bright body + vivid accent), NOT sampled from the screenshot — a dull/inactive capture must never grey or
   dull a designed accent.** Use `icon_theme.recolor_designed`. → step 3b.
3. **Build the DOM from the AX tree as a real, semantic frontend.** Drive every element from its AX role
   through `markup.el_from_node(node, …)` (single choke point: role→tag via `role-map.json`, stamps
   `data-ax-*`) → semantic tags, REAL focusable controls (`<button>`, `<input>`, `role=tab/slider/combobox`),
   `interactive.css` for focus/hover, laid out as a NESTED normal-flow hierarchy (landmarks + flex/gap/
   margin) that reads like a hand-written app — NOT a flat `position:absolute` div canvas. Use judgment to
   make it look like a real frontend; carets are their OWN focusable elements, never glued into a label.
   Flat absolute-div / sprite clones are the fallback ONLY when the AX tree is opaque (Electron-no-CDP,
   CEF, SceneKit). → step 6.
4. **Consolidate the learnings — load ONE method, not fragments.** Every cross-app law (fresh-crop-only
   pixels, dev-picks-once auto-iteration, per-region acceptance gate, reconstruct-never-image, incremental
   reuse, platform capture gotchas) is indexed from `[[replicate-ui-method]]`; the steps below and the
   deep-dive memories carry the specifics.

Everything after this section is the detailed loop that implements these four pillars.

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

2b. **Scope — selection vs whole window.** Call `get_selection`. If `present` is true —
   the user picked component(s) in the desktop app (⌘⇧S on the target app, then click; ⇧+click
   adds more) — and `age_seconds` is recent (under ~600; if older, confirm with the user it's the
   intended pick), switch to **COMPONENT-ONLY mode**: skip the whole-window inventory and replicate
   *just* the selected element(s). For each element, first decide whether to trust its `bounds`:

   **Native reference crop — prefer `crop_path` (healthy picks only).** A *healthy* pick carries
   `crop_path`: a PNG of that element captured AT PICK-TIME (cropped from the owning window, free of
   the pick overlay). It stays valid even if the app has since been **closed or moved to another
   Space**, so use it as the native reference (`compare_images` `a_path`) instead of a live
   `screenshot_region` whenever it's non-null — no need to keep the target app on screen. Fall back to
   `screenshot_region { x,y,w,h }=bounds` only when `crop_path` is null AND the app is still visible.
   For **shallow picks `crop_path` is intentionally null** (the bounds were a click-centered placeholder,
   not the real element) — don't treat that as a capture failure; re-resolve via `extract_component`
   at the click as below (this needs the app still running).

   - **Healthy AX pick** (`ax_shallow` is false **and** role isn't AXMenuBar/AXApplication/AXWindow):
     PREFER the element's stored **`ax_tree`** from `get_selection` for roles/structure — it's the
     pick-time subtree and stays valid even after the app is closed/switched; only if `ax_tree` is
     null fall back to the live `ax_subtree_at_point { x: bounds.x+bounds.w/2, y: bounds.y+bounds.h/2 }`.
     Use the element's `crop_path` (else `screenshot_region { x,y,w,h }`=`bounds`) for the native
     reference, `extract_component { x, y }` for a DOM/CSS head-start.
   - **Shallow AX pick** (`ax_shallow` is true, or role ∈ {AXMenuBar, AXApplication, AXWindow}): the
     native AX tree couldn't see the real element — normal for **Electron** apps (Slack, VS Code),
     whose web content isn't exposed to AX. **Do NOT use `bounds`** (it's a click-centred placeholder,
     not the real element). Instead call `extract_component { x: click.x, y: click.y }` (the full
     CDP→AX→screenshot ladder at the exact click). If it returns **ElectronNeedsRelaunch**, tell the
     user and **offer** `relaunch_with_debug_port { bundle_id, display_name, confirm: true }` (this
     quits & reopens that app — only with their OK), then retry `extract_component` at `click`. Use the
     **returned element's** bounds for `screenshot_region` and for sizing the replica.

   Then Generate (6) + verify (7–9) the component against its crop, sized to its point bounds.
   (Multiple selected elements → compose them.) If `present` is false/empty, proceed with the
   **whole-window** flow below.

2c. **Reuse check — METHOD only, NEVER stale pixels.** 🚫 **THE GOLDEN RULE OF REUSE: the
   CURRENT capture (for a selected component, the pick-time `crop_path`) is the SINGLE source of
   truth for every pixel — colours AND sprites alike. NEVER reuse colours, sprite PNGs,
   `window.png`, or a prior `index.html`'s pixels from an earlier run.** A previous capture can be
   from a different theme/appearance/state — reusing its pixels silently ships the WRONG background
   shade or a stale icon (e.g. a dark Share button, or a `#1b1b1b` fill where the live app is
   `#282828`). The dev must never have to point at a wrong colour or icon. So every run **re-derives
   all pixels from the fresh capture: re-sample EVERY colour and re-slice EVERY sprite from it.**
   Run `python3 "<skill-base>/_shared/cache.py" <app> [win_w win_h]` (app = the working-dir name) to
   see what's cached, but reuse is limited to the **METHOD**, not pixels:
   - ✅ **REUSE — generator script** (`build.py`): the layout structure + per-element coordinate
     map. Re-run it against the FRESH capture so it re-samples colours + re-slices sprites anew.
   - ✅ **REUSE — text fonts** (`assets/fonts/*.woff2`): glyph files don't change page-to-page.
   - ✅ **REUSE — grid-OCR labels** (`capture/headers_cache.json`) ONLY when the capture is
     byte-identical (same mtime) — `gridtext.py` already guards on this.
   - ❌ **DO NOT REUSE — colours / sprite PNGs / `window.png` / prior `index.html` pixels.**
     Re-capture (or use the fresh crop) and regenerate these every run. `cache.py` reports these as
     present for speed context, but they are a *stale-pixel trap* — re-derive, don't copy.
   First page of an app → nothing cached → full cost. Thereafter you save the *method* (no
   re-measuring layout, no re-OCR, no re-harvesting fonts) — but pixels are always fresh.

   **WARM START (pages 2+ of the SAME app) — reuse is allowed only after THIS page verifies it:**
   - ✅ **Icon pool**: call `resource_extract.extract_pool(app_path, cache_dir="pool")` — it
     fingerprints the bundle (path + version + resource mtimes) and skips re-extraction (the slowest
     harvest step) when the app hasn't changed. Safe by construction: the pool comes from the app
     BUNDLE, never from a previous page's screenshots; any bundle change re-extracts.
   - ✅ **Locked icons**: capture the fresh window FIRST, then triage every `icon_map.json` entry with
     `icon_match.lock_decision` (see 3b). `reuse`/`reverify` skip the per-icon confirm round entirely —
     the `reverify` list just needs one `icon_gate.py … --only <list> --update-locks icon_map.json`
     pass against the fresh capture after the first render. A reused icon that hasn't gate-PASSED
     this page is an UNVERIFIED icon — it never ships.
   - ❌ Colours, window screenshots, sprite crops: fresh every page, exactly as above. The golden
     rule is unchanged — the fresh capture stays the single source of truth; caching only ever skips
     RE-DERIVATION, never the verification.

3. **Inventory.** `ax_tree { pid, window_index: 0 }` → the component tree (roles,
   names, values, per-node `bounds`). This is your structural source of truth — a
   screenshot can't give you roles/labels. For Electron apps the AX tree may be
   shallow; if so, use `extract_component { x, y, pid }` for a high-fidelity
   DOM/CSS head-start (it returns `html`+`toon`), or call
   `relaunch_with_debug_port { bundle_id, display_name, confirm: true }` first
   (this quits & reopens the app — only with the user's OK).

   **SAVE THE AX TREE — it's a deliverable, not scratch.** Write the `ax_tree` result
   verbatim to `.replicate-ui/<app>/ax_tree.json` (pretty JSON). In **component mode**
   (2b), the per-element **`ax_tree`** returned by `get_selection` is ALREADY the pick-time subtree —
   write THAT to `ax_tree.json` (no separate `ax_subtree_at_point` call needed unless it's null).
   This file is the **canonical
   semantic spec** of the UI (every control's role/name/value/bounds/children); the
   replica's HTML carries the same data inline (step 6), and `ax_tree.html` (step 10)
   renders it. (No AX tree for pure-CDP/Electron captures — that's honest; don't fake one.)

3b. **Harvest real assets — ALWAYS (do this every run).** 🚫 **Real assets are mandatory.
   NEVER hand-draw, approximate, or substitute an icon, image, avatar, or font.** Every one of
   them in the replica MUST come from a harvest (`extract_assets`) or the reuse cache — this is
   not optional and not something to defer or "fix later." Hand-drawn SVGs are the #1 cause of a
   replica that looks wrong; the user should never have to point one out. So:
   - **Run `extract_assets { }` on every run** (it reads the LIVE renderer, so it's never stale).
     Per step 2c, reuse only the cached **fonts** (`assets/fonts/*.woff2`) verbatim; re-derive
     **icons/SVGs/images** from this run's harvest, not a prior run's pixels.
   - If the target is **Electron without a debug port**, *offer* `relaunch_with_debug_port` to
     enable the harvest — do **not** fall back to drawing.
   - **DEFAULT per-icon sequence — do ALL of this on the FIRST pass (don't wait for the dev to flag a
     wrong icon):** (1) resolve the resource (`.kui`/pool + `icon_match.match` visual prior); (2)
     **recolour by CLASS ROLE** via `icon_theme.recolor_svg` — body→native grey, named-accent→accent,
     NEVER one-colour-per-icon; (3) **SAMPLE** the body grey + each accent from the fresh native crop and
     bake them (dark accents are softer than kd defaults); (4) run the **icon gate** (step 8b) and
     auto-iterate until clean. Getting (2)+(3) right on attempt 1 is what makes the first render correct.
   - **Icon selection is VISUAL-MATCH-DRIVEN + LOCKED (use `icon_match`; name-matching alone
     whack-a-moles).** Pipeline: `resource_extract.extract_pool(app_path)` → the app's full real-icon
     pool; then per control `icon_match.match(native_crop, pool, idx, name_prior=<.kui/AX/data-qa>,
     keywords=[…])` ranks candidates by **colour-invariant silhouette score** — the native PIXELS decide,
     the name map only shortlists/biases (a clearly-better visual match wins). The model **confirms each
     pick once** (native-vs-top-k grid) and it's **locked in `icon_map.json`** (`{resource,confirmed,
     crop_hash}`). **HOW TO LOCK (mechanical, not prose):** the ONLY sanctioned writers are
     `icon_match.confirm_pick(map_path, name, resource, native_crop)` and the gate's
     `icon_gate.py … --update-locks icon_map.json` (which locks every PASS icon with this run's located
     native crop). 🚫 NEVER `json.dump` over `icon_map.json` from a generator — that clobbers entries and
     skips `crop_hash`, which made every "lock" silently inert (the Photoshop run shipped 61/61 hashless
     entries). **On later pages/re-runs**, triage each control with
     `icon_match.lock_decision(entry, crop_hash(fresh_crop), pool_idx)`:
     `reuse` (capture byte-identical — place it, free) · `reverify` (the NORMAL cross-page case: place the
     locked resource, then it must gate-PASS against THIS page's capture via
     `icon_gate.py … --only <names> --update-locks icon_map.json` — never reuse on faith) · `repick`
     (no confirmed entry / resource gone from the fresh pool → full pipeline). This is what kills
     "fixed one, broke another" AND makes pages 2+ fast without trusting stale pixels. Notes: render candidate masks via
     BATCHED `qlmanage` (use luma, not alpha — qlmanage paints an opaque white bg); CAP the keyword
     shortlist (substring `"line"` → 1000+ candidates). Thin/accent-only glyphs stay low-confidence → the
     model's eye on the top-k. 🚫 **A LOW match score is NEVER a reason to screenshot-crop the glyph.**
     When `icon_match` scores low (thin/small/dark-theme icons routinely do), DON'T fall back to a crop —
     **grep the pool basenames by the command name** and DIRECT-MAP control→basename (PDF apps: almost all
     `Pdf_*`; themed app icons end `_kd`), then eyeball native-vs-candidate to confirm the exact glyph
     (e.g. WPS-PDF "Shapes" draws a *line* → `DrawLine`; "Note" is a bubble+plus → `bubble_add_kd`). The
     visual score is a tie-breaker, not the decider. See [[replicate-ui-real-icons-first-never-screenshot]].
     **THE LAST RESORT — a CLEAN Retina crop (allowed, but only here):** when, AFTER pool matching +
     direct-mapping + recolour, an icon STILL fails the gate (or its EYEBALL tile is visibly a different
     glyph — in practice ~1–2 icons in 10), stop fighting the pool: crop that one control from the
     **FRESH window capture at full device resolution** via `sprite.SpriteSlicer` (never a pre-scaled
     screenshot), tight-cropped to the glyph box the gate already located, and render it at point size
     (`width:Wpx` on the 2× image) so it stays crisp. The app's own pixels are correct by definition —
     this preserves quality precisely where resource matching can't. It must still pass the gate (it
     will), and it must come from THIS run's capture, never a previous page's. What stays forbidden is
     using crops as a shortcut INSTEAD of pool extraction, or reusing an old crop.
     This is HOW you pick from the real resources below:
   - **For ANY native app (no CDP — Office, Finder, WPS, Mail, System Settings…) the icons are REAL
     resource files inside the app's INSTALL BUNDLE. Extract those. A screenshot crop is a LAST
     RESORT, never the default.** 🚫 Do NOT screenshot-crop an icon when its real file exists — a
     scaled screenshot crop is small/blurry/dim and bakes in the background (this was a flagged
     mistake). For a NEW app, FIRST find where it's installed (`ps -p <pid> -o comm=` /
     `mdfind`/`/Applications/<App>.app`); its icons live under one resource tree. Check, in order:
       • **AppKit** (Office, Finder, Apple apps): compiled catalog **`Assets.car`** via
         `_shared/native_icons.py`+`catalog_extract`: `find_catalogs(app_path)`→`build_pool(car,out)`→
         `load_pool(out,"normal_dark"|"normal")`. `name_match(ax_name,pool,extra=[catalog name])` supplies
         only the NAME PRIOR — `icon_match` still DECIDES by pixels (pillar 2); this holds for AppKit too.
       • 🎯 **CONFIG-DRIVEN RIBBONS (WPS/Kingsoft & any app shipping a ribbon definition): RUN THE
         RESOLVER TOOL FIRST — do NOT guess names.** This is the #1 repeated failure: a session guesses a
         plausible icon name (or trusts the silhouette score on tiny dark glyphs) and ships the WRONG
         glyph — even though the app ships the EXACT command→icon map. Prose telling you to "read the
         .kui" did NOT stop it, so this step is mechanical and MANDATORY. Before picking any ribbon icon:
         `python3 "<skill-base>/_shared/ribbon_config.py" --app /Applications/<App>.app --module et|wps|wpp|pdf
         --labels "Btn One;Btn Two;…"` → it parses the app's WHOLE `.kui`/`.kuip` config and returns each
         button's exact `icon=` basename (+ alternates). KEY: the top-level `*ongmani.kui` is mostly
         titlebar/file-menu — the ribbon bindings live in its `<import>`s (`etcommon.kuip`,
         `commands/<module>/ongmani/CT_<Tab>.kuip`, …) which the tool scans; the binding is keyed by
         `id=`/`ksoCmd=`/`text=`, NOT `name=`. `--module` disambiguates labels shared across modules
         (et=Sheets, wps=Writer, wpp=Presentation, pdf=PDF). For a button whose UI label ≠ command text
         (e.g. Sheets **"Highlight Row & Column" is the *Reading Layout* command → `reading_mode_kd`**),
         run `--grep <keyword>` / read the full dump (no `--labels`) and match by meaning. 🚫 NEVER
         hand-pick a name and 🚫 NEVER claim "verified from the .kui" unless this tool produced it. THEN
         pull each basename from the pool (below), recolour by class (keep accents), and STILL confirm
         every placed glyph against a fresh native crop (the gate, step 8b) — the map is exact, but you
         confirm colour + placement. (`--pid <pid>` locates the app from a running process.)
       • **Qt / Kingsoft / cross-platform (WPS & many others): Qt resource bundles `*.rcc`/`*.qrc`**
         (e.g. WPS `…/Contents/Resources/office6/mui/default/prometheus_kso_res.rcc`,
         `…/skins/<active-theme>/default/*.rcc`). Parse the `qres` format directly: header magic
         `qres`, u32 version/tree_off/data_off/name_off; v2 = fixed 22-byte tree nodes (name u32, flags
         u16[1=zlib,2=dir]; dir→child_count/child_idx; file→…/data_off u32 @+10; +u64 mtime); names
         `[u16 len][u32 hash][utf-16BE]`; data `[u32 len][bytes]` (usually UNCOMPRESSED svg/png; zlib via
         `zlib.decompress(b[4:])` iff flag&1). Walk tree→`{path:bytes}`, match the command name
         (`/icons_svg/24x24/FormatPainter.svg`,`Shapes.svg`,`Fill.svg`,`OutLine.svg`,`ShapeEffect.svg`,
         `Group.svg`,`BringForward.svg`,`SelectObjects.svg`…).
       • **Loose files**: `Contents/Resources/**` png/svg/`.icns` dirs, theme/skin folders.
     **Prefer SVG** (vector → crisp at the measured size). Theme-aware vectors keep the glyph in a
     `<style>` whose **BODY** class is theme-following (`kd-color-icon-primary` / `.colorBlackStroke` /
     `var(--kd-color-icon-primary,#333333)`) and whose **ACCENT** lives in a sibling NAMED class
     (`kd-color-icon-blue-primary`, `.colorOrangeStroke #DC5513`). 🚫 **NEVER recolour with ONE colour
     per icon** — that paints the BODY in the accent colour (a fully-blue document instead of grey-doc +
     blue badge). It's invisible on monochrome icons and only bites accented ones, so it hides until you
     eyeball them (this was a real regression on PDF→Word/Excel/PPT/Picture-to-PDF). Use the canonical
     **Colour = the icon's DESIGNED accent, NOT the screenshot — `_shared/icon_theme.recolor_designed(svg,
     body_hex)` (the capture-INDEPENDENT default; correct on the FIRST pass).** BODY classes → the
     ACTIVE-window icon grey (BRIGHT ≈`#cfcfcf`); each NAMED-accent class → its DESIGNED VIVID dark accent
     (`DARK_ACCENTS`: green `#25b06e`, blue `#3d8bf5`, orange `#ef7d12`, red `#ec5347`, …). **An icon with a
     named accent class is ALWAYS coloured + vivid; no accent class ⇒ monochrome grey.** 🚫 **Do NOT take an
     icon's colour by SAMPLING the screenshot** — a background/inactive/unfocused window desaturates the
     WHOLE toolbar (dim grey body + muted accents) and tiny glyphs blend toward grey under AA, so sampling
     ships DULL or GREY icons (this exact bug cost two dev round-trips on WPS-Sheets Formulas: logical/text/
     mathtrig/lookup are designed `green` but the inactive capture greyed them). The screenshot only REFINES
     a hue — `recolor_designed(refine={word:(r,g,b)})` nudges the accent hue ONLY when that glyph is
     genuinely saturated; a dull/grey/desaturated sample is IGNORED and can NEVER flatten or dull a designed
     accent. Disabled/dimmed tools ⇒ dim the WHOLE button (opacity), never grey the accent. Colours MUST be
     baked (an `<img src>` SVG can't inherit; qlmanage/Chromium ignore CSS vars); recolour at BUILD time.
     Place each icon at its **measured glyph box** (step 6).
   - 🚦 **MANDATORY colour-aware icon gate — don't stop until it passes.** The silhouette-mask scorer is
     COLOUR-BLIND and whole-strip SSIM is alignment-dominated — BOTH miss a wrong body colour or wrong
     accent. After placing icons, run **`_shared/icon_match.gate_icon(native_crop, replica_crop)`** per
     icon: it scores shape AND samples body+accent on BOTH sides (≤~24/ch). Template-locate each native
     glyph by sliding the (clean) replica glyph over a generous window — NEVER trust a fixed box (it
     catches label text: "Pic"/"Extr"/"Sc"). Re-pick/recolour every failure and re-run until each icon
     matches in shape AND colour. This is the *separate icon accuracy predictor*; a low whole-strip SSIM
     is never an excuse to ship a wrong icon.
   - **Screenshot-crop = per-icon LAST RESORT**, only when an element genuinely has NO resource file —
     a *runtime-rendered/dynamic* preview (WPS's "Abc" shape-style thumbnails, a slide thumbnail, an
     avatar). Then crop the real pixels (`key_bg`/transparent-key) — never hand-draw — and SAY in the
     report that you cropped it and why no resource existed. Icon-font apps: read the codepoint + embed
     the harvested woff2.

   On the harvest itself: `extract_assets { }` pulls assets straight from the live renderer via CDP
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
   AX inventory for structure/text and the reference shot for colors, spacing, and fonts.
   **🔑 Single pixel source:** sample EVERY colour and slice EVERY sprite from the **same current
   capture you will diff against** — for a selected component that is the pick-time `crop_path`
   (set the generator's source image to the crop *before* any sampling/slicing). NEVER read a
   colour from a cached constant or an older capture; that's the `#1b1b1b→#282828` stale-bg trap.
   If you reuse a prior generator (step 2c), confirm its `C_*` colour samples and sprite slices
   read from THIS run's image, not the one baked at its last run.
   **Sample colors with `sample_color` at MULTIPLE points — don't assume one flat fill.**
   Backgrounds vary: a title-bar strip, a header band, and the body can be different shades
   (e.g. Slack's lighter title bar over a darker aubergine body) — sample each region; guessing
   a single bg color is a common, visible miss. **Sample the fill that shows in the GAPS between
   icons too** (the container background) — that's the one that bit us as a too-dark ribbon.
   For **icons and images**, drop in the real assets from step 3b (inline the harvested SVGs /
   reference the saved PNGs + woff2). 🚫 **NEVER hand-draw an icon. If you find yourself about to
   write an SVG path from scratch, STOP and harvest or crop the real one** (step 3b's exact-icon
   fallback) — a hand-drawn approximation is never acceptable, even for a "simple" glyph. A tiny
   generator script that reads the manifest and substitutes assets by name keeps this repeatable.

   **Emit SEMANTIC, interactive markup — never one flat image or all `<div>`s.**
   Every control is an *individual, real, focusable element* chosen by its
   accessibility **role**, mapped through the shared, platform-agnostic
   `_shared/role-map.json` (via `_shared/markup.py`'s `role_el`/`el`; AX roles *and* ARIA/DOM roles → tag):
   `AXButton`/`AXMenuButton`/`AXCheckBox` → `<button>` (with `aria-haspopup` /
   `aria-pressed`); a radio in a tab group → `<button role="tab" aria-selected>`;
   `AXComboBox` → `role="combobox"` + `<input>`; `AXTextField`/`AXSearchField` →
   `<input type=text|search>`; `AXSlider` → `role="slider"`; `AXStaticText` →
   `<span>`. The icon artwork (sprite PNG for AX apps, inline SVG for Electron)
   goes **inside** the real control. Inline `_shared/interactive.css`
   for the button/input reset (so wrapping is a pixel no-op) + hover/focus/active.
   This is **platform-agnostic** — drive it from the role, never special-case per
   app. Static clone: set `aria-selected`/`aria-pressed` at build time; no JS.

   **Stamp the AX tree onto the markup (`data-ax-*`).** Every element you emit from an AX node
   must carry its semantics inline: `data-ax-role`, `data-ax-name`, `data-ax-bounds` (+
   `data-ax-id` / `data-ax-value` / `data-ax-subrole` when present). Don't hand-write these —
   build the element with **`markup.el_from_node(node, inner=…, cls=…, style=…)`** (the single
   choke point: it stamps `data-ax-*` then maps role→tag via `role-map.json`). This makes the HTML
   self-describing (the *code* contains the AX tree, matching `ax_tree.json`) and lets a viewer
   overlay/inspect controls. The bar: every node-derived element carries `data-ax-*`.

   **Native-app pixel-perfect rules (learned from Office ribbons — apply every time, no prompting):**
   - **Measured glyph box, NEVER a fixed square.** Place each icon at the exact (x,y,w,h) measured
     from the native crop (`native_icons.measure_glyph_box`), not a hardcoded 32×32. Native glyphs
     vary in size/aspect (e.g. a wide ~39×28 Margins icon); forcing a square mis-sizes + shifts the
     whole row — this was THE layout-broken root cause. (Screenshot sprites never had it because the
     sprite *was* the exact pixel block at the exact position.)
   - **Crisp, not thick:** use the LARGEST catalog rendition and downscale to the measured box; never
     upscale a small rendition (→ blurry/thick strokes).
   - **Dropdown indicators from the AX role — and there are TWO kinds, don't conflate them:**
     • `AXMenuButton`/`AXComboBox` → a **single** down caret `⌄` (`native_icons.caret_for`), to the
       RIGHT of the icon (tall buttons) or after the label (row buttons).
     • `AXPopUpButton` (a value box like Word's citation **Style: [APA]**) → an **up/down double
       chevron** `⌃⌄` on the right INSIDE the box (`native_icons.popup_spinner()`), NOT a single caret.
     • `AXButton`/`AXCheckBox` → NONE. Never guess.
     • **A caret is its OWN element, NEVER a character glued into the label string.** Emit it as a
       separate clickable/focusable component — `<span class="caret" role="button" aria-haspopup="menu"
       data-ax-role="AXMenuButton" tabindex="0">⌄</span>` (like Excel's separate `caretbtn`) — so it is
       an individual control, not text. Writing `f"{label} ⌄"` is WRONG (flagged by the dev). The split
       button itself carries `aria-haspopup`. Inline `_shared/interactive.css` so every `role=button`/
       caret gets cursor/hover/focus. This holds for ALL apps.
   - **Render what the native DRAWS, not the AX name.** A control's AX name is a label, not its visual:
     e.g. the citation-style popup is named `"Style:"` but Word draws the `SelectBibliographyStyle`
     book+brush ICON before the box, with no "Style:" text — so place the icon, not the literal name.
     When AX gives a name that the UI shows as an icon, find + place that icon (catalog or crop).
   - **Verify each icon's GLYPH, not just its position.** A name match can be the right name but the
     WRONG glyph: catalog `InsertCitation` is a page with `(−)`+check, but Mac Word draws a scroll with
     green `+`/red `−`. In the stacked view (step 8) ZOOM into every icon and compare SHAPE + accent
     COLOURS; when the catalog glyph differs from native, force that control to a screenshot **crop**
     (`["CROP"]` sentinel) — the guaranteed-exact fallback. (Automated glyph cross-correlation is too
     noisy to gate on — it scores correct matches as low as wrong ones; rely on the zoomed stacked check.)
   - **Disabled/greyed controls → reduced opacity** (~0.4) when the native shows them dimmed.
   - **Steppers (`AXIncrementor`)** = label + bordered value box (value from the AX `value`) + up/down
     arrows + the small inline indicator icon (crop it from the native). Render **group sub-labels**
     (`AXStaticText`) at their AX positions; align labels + boxes in columns under their header.
   - **Share/accent buttons obey the no-hand-draw rule (3b):** sample the exact fill from the crop +
     use the REAL glyph (`ic_fluent_share` etc.) — wrong twice when drawn (Excel `#3e8745`, Word `#3d6ede`).

   **Lay it out as a NESTED HIERARCHY in NORMAL FLOW — not a flat `position:absolute`
   canvas.** Emit real landmark containers (`<header>`/`<nav>`/`<aside>`/`<main>`/
   `<section>`) and place children with flexbox + normal flow (`display:flex`, `gap`,
   `margin`, `margin-left:auto`, `padding`, `flex` ratios) — *not* per-element
   `left`/`top`. Reserve `position:absolute` for **genuine overlays pinned inside a
   `position:relative` parent** (a presence dot on an avatar corner, a dropdown caret,
   a focus ring) — never as the primary layout mechanism. This holds even when the
   source gives you pixel bounds (AX tree / screenshot): translate those bounds into
   container `padding`/`gap`/`margin` **once**, computed from the measured constants,
   so the markup reads like hand-written code and stays accessible/maintainable. Two
   techniques keep it pixel-exact: **anchor each group/section by its fixed edge**
   (toolbar right-group via `margin-left:auto` + a fixed end-padding; let intra-group
   `gap`s fall inward) and **re-anchor long vertical lists per-section with an explicit
   `margin-top`** (so flex rounding resets per section instead of accumulating).
   Center text with the row container's `align-items:center` + leaf `line-height:1`
   (font-metric-robust; avoids per-element vertical offsets). These techniques are
   **app-agnostic** — a DOM-sourced app (Slack), a screenshot/AX-opaque one (Acrobat), and a
   dense AX one (Excel: nested ribbon groups, a recursive x/y→margin renderer, one A1 overlay)
   all nest + flow through the same `_shared/markup.py` + `role-map.json`. There are **no
   per-app generators to copy**: apply the method here, writing the HTML directly or via one
   throwaway generator in the output dir that imports the toolkit. See the playbook for worked
   patterns.

   **Grid labels (column letters / row numbers / a date strip baked into one image) →
   REAL TEXT, never a sprite.** Use the shared `_shared/gridtext.py` (AX →
   OCR → sequence-repair): detect the range + cell sizes from the capture's gridlines
   (never hardcode the count), get each label from AX if exposed else OCR each cell (macOS
   Vision via `_shared/vision_ocr.swift`) and repair with a `kind` (alpha/numeric) — OCR
   gives the start (scroll-aware), the kind only cleans noise + fills misses. Render real
   `<div>` cells; detect the selected row/col highlight. Reuse across apps; Excel headers
   are the reference. (Real text costs a little SSIM vs the sprite in dense bands — expected.)

7. **Render.** Via the `playwright` MCP:
   - `browser_resize { width: point_w, height: point_h }`
   - `browser_navigate { url: "file:///abs/path/to/replica.html" }` — if this errors with
     "Access to file: protocol is blocked", serve the dir (`python3 -m http.server` in the output
     folder, run in the background) and navigate to `http://127.0.0.1:<port>/index.html` instead.
   - `browser_take_screenshot { filename: "replica-<component>.png" }` → note the saved path.

8. **Verify — `compare_images` PLUS a STACKED pixel comparison (required; do not skip).**
   `compare_images { a_path: <native crop>, b_path: <replica> }` → read `score` and the red diff
   **heatmap**. THEN also build a **stacked image — native on top, replica directly below at the same
   width — and look at it**, plus **per-region crops** of every busy area (each icon group). **Zoom
   into EVERY icon and compare its GLYPH — shape + accent colours + which dropdown indicator (single
   `⌄` vs up/down `⌃⌄`)** — not just whether something sits in the right place. The stacked view is how
   you actually catch the errors the dev would otherwise flag (wrong icon, wrong glyph under a right
   name, mis-sized icon, single-caret-vs-spinner, AX-name-as-text instead of the drawn icon, misaligned
   label/box) — the number alone won't. When a glyph differs, crop it (`["CROP"]`) and re-verify.
   **Judge LAYOUT by alignment, not the score:** where icons/shapes land ON the native they go
   **dark** in the heatmap = aligned. **SSIM is TEXT-CAPPED:** on label-dense UI (ribbons) real-text
   labels (browser vs native font AA) hold the score ~0.55–0.75 even when the layout is pixel-exact —
   that residual red is *text*, not a defect. So don't chase the number; confirm in the stacked view
   that **icons, colours, chevrons, and positions** all match, region by region.

8a. **PER-REGION ACCEPTANCE GATE (HARD — overrides the SSIM stop).** The stacked/zoom check above is
   NOT advisory. Before any region is "done" it must pass all three *sampled* checks. "SSIM is
   text-capped / diminishing returns" (step 9) is a stop ONLY for residual **text** antialiasing — it
   NEVER excuses a size, colour, or decoration defect. For EVERY control in the region:
   1. **Icon size — measured, not fixed.** Each icon's box comes from `native_icons.measure_glyph_box`
      (or an equal bright-pixel tight bbox); tight-crop/trim so the glyph FILLS its box (a padded crop
      shrinks+dims the glyph under `object-fit:contain`; a real SVG must be sized to the measured glyph,
      not its padded viewBox). Re-measure the glyph in the REPLICA render; it must match native within
      **±2-3px** in w and h. A fixed-size, padded, or wrong-coloured (invisible→tiny) icon is a FAIL.
   2. **Colour parity — sample BOTH sides.** `sample_color` the SAME point on the native crop AND the
      replica render for every label, fill (incl. gap/container bg), colour-indicator bar, border, and
      selection/active state; assert per-channel |Δ| ≤ **12**; record native-vs-replica hex. Over
      tolerance ⇒ fix the sampled constant (don't eyeball) ⇒ FAIL. (Tip: small text on a dark bg
      renders dim under `-webkit-font-smoothing:antialiased`; drop it to match native brightness.)
   3. **Decoration enumeration.** List EVERY decoration native draws (underlines, *bordered* colour
      bars, selection borders, chevrons `⌄` vs `⌃⌄`, dividers, badges) and confirm each is reproduced
      (present, placed, colour within ±12). A native decoration with no replica counterpart is a FAIL.
   Report per region: icons measured (max px Δ), colour samples (count, max channel Δ), decorations
   (found / reproduced). Only after all three pass for every region do step 9's stop criteria apply.

8b. **ICON ACCEPTANCE GATE (HARD + RUNNABLE — the icon part of "done").** Icons are where "looks fine"
   repeatedly shipped wrong, so this is not judgment — it's a command you MUST run and show. Your
   generator emits **`icon_boxes.json`** (`{name:[x,y,w,h]}` — each icon's box in the render; you know
   every position) and renders the replica at the native region's point size, then runs
   **`python3 "<skill-base>/_shared/icon_gate.py" <native>.png <replica>.png icon_boxes.json
   --update-locks icon_map.json`** (wire it as the LAST step of the build so it can't be skipped — see
   `.replicate-ui/wps/build_tools.py`). `--update-locks` writes/refreshes the lock (with `crop_hash` of
   this run's located native crop) for every PASS icon — this is how locks get recorded at all; an
   EYEBALL you confirm by eye must then be locked explicitly via `icon_match.confirm_pick`. On warm
   pages add `--only name1,name2,…` to gate just the reused subset (step 2c). The
   gate template-LOCATES each native glyph (slides the clean replica glyph — never a fixed box, which
   catches label text), compares shape + body/accent colour, writes a native|replica **contact sheet**
   (`_icon_gate.png`), and exits: **0** all PASS · **1** a gross colour FAIL (fix + rebuild) · **2** some
   EYEBALL (low-confidence localize / low shape / thin glyph). 🚦 **You may only treat icons as done when
   the gate is exit 0, OR exit 2 with EVERY `EYEBALL` tile confirmed identical by your own eye on the
   contact sheet.** A `FAIL` is never "done"; an unreviewed `EYEBALL` is never "done". (The gate is
   deliberately conservative on tiny AA'd glyphs — colour metrics are noisy, so it hard-fails only gross
   errors and routes the rest to your eye; the recolour step in 3b is what makes the FIRST render correct.)

9. **Iterate — YOURSELF, to the bar. The dev picks once and never iterates.** If `pass` is false
   (score < 0.92): inspect the heatmap, fix the HTML/CSS for the highlighted regions, re-render,
   re-diff. **Run EVERY iteration autonomously** — re-sampling colours, re-slicing sprites, and
   nudging alignment are all YOUR job, done from the crop you already have. 🚫 **NEVER stop at a low
   score to hand the loop back to the dev, and NEVER ask the dev to do something the crop already
   enables** (bring the app forward, confirm a colour, pick again). The dev performed exactly one
   action — the pick — and is owed the finished, verified component. With pixels sampled fresh from
   the crop (step 6), the first render is already close, so this is a few quiet internal rounds, not
   a dev round-trip. Stop when:
   - `score ≥ 0.92` (pass), **or**
   - **6 iterations** on this component, **or**
   - two consecutive iterations improve `score` by **< 0.005** (diminishing returns).
   - **Gate precondition:** none of these stops apply until **8a passes** for the region — a
     size/colour/decoration FAIL is never "diminishing returns" or "text-capped."
   Report the final score per component; never silently accept a low score — but reaching the stop
   condition is YOUR call to make and report, not a question to bounce to the dev.

10. **Compose & final-verify.** Assemble verified components into the full page at
    the window's point size, render, and `compare_images` against the
    `screenshot_window` shot. Report the final whole-window score and write the
    final `index.html`. **Then make the folder a complete spec:** ensure
    `ax_tree.json` is present (step 3) and copy `_shared/axtree_view.html` →
    `.replicate-ui/<app>/ax_tree.html` (it loads `ax_tree.json` and renders the
    collapsible tree). Deliverable = `index.html` (visual + `data-ax-*`) +
    `ax_tree.json` (canonical spec) + `ax_tree.html` (viewer).

    **Show it IN THE APP, not at a URL.** Call the `show_replica { dir: "<abs path to
    .replicate-ui/<app>/" }` MCP tool — it loads `index.html` (assets auto-inlined) +
    `ax_tree.json` into the Echo app's result panel (Preview / HTML / AX Tree
    tabs) and brings the window forward. This is the user-facing preview; do NOT spin up
    `python3 -m http.server` or hand the user a `localhost` URL. (Playwright + a local
    file/server are still fine as YOUR private render target for the `compare_images`
    verify loop — just don't surface a URL as the deliverable.)

11. **Pre-done asset check (REQUIRED — do not skip).** Before you report the replica as done,
    audit the markup: **every icon, avatar, image, and font must be a real harvested asset** (from
    `extract_assets` / the cache) or a pixel-crop of the real element — **zero hand-drawn or
    placeholder assets** (no improvised `<svg><path>`, no initials-in-a-box avatars, no guessed
    glyphs). Re-look at the diff heatmap with the icon/background regions specifically in mind. **Also
    confirm every colour — especially the container/gap background — was sampled from THIS run's
    capture (the fresh crop), not a cached constant or older capture.** The bar is **exact assets and
    exact colours on the first attempt** — the user should never have to tell you an icon, background,
    or colour is wrong. If anything is still approximate, fix it (harvest/crop/re-sample) before
    declaring done.

    **AX-tree deliverables (REQUIRED too):** confirm `.replicate-ui/<app>/ax_tree.json` exists and
    equals the `ax_tree` MCP output, `ax_tree.html` is present, and every node-derived element in
    `index.html` carries `data-ax-*` (built via `markup.el_from_node`). The output is a complete
    semantic spec — visual + structure — not just a picture.

    **You may only say "done" after (a) the runnable ICON GATE (step 8b) is clean — exit 0, or exit 2
    with every EYEBALL tile confirmed by eye — AND (b) the STACKED native-over-replica comparison (step
    8) passes your eye region-by-region.** Never report done while any icon isn't identical to native;
    "diminishing returns" / "SSIM text-capped" / "good enough" are NEVER reasons to ship a wrong icon.
    For native-app replicas, that audit explicitly confirms: every icon came
    from the catalog (or a real crop) and sits at its **measured glyph box**; **chevrons exactly match
    the AX roles** (AXMenuButton only); greyed/disabled states are dimmed; steppers/sub-labels align in
    columns; the Share/accent button uses the **real glyph + sampled colour** (never hand-drawn). The
    bar is that the dev never has to point out a layout, icon, chevron, or colour mistake — catch them
    yourself in the stacked view first.

## echo tools (reference)
`check_ax_permission`, `request_ax_permission`, `frontmost_app`, `list_windows`,
`ax_tree`, `ax_node_at_point`, `ax_subtree_at_point`, `screenshot_region`,
`screenshot_window`, `sample_color`, `color_palette`, `relaunch_with_debug_port`
(destructive — needs `confirm:true`), `extract_component`, `extract_assets`
(real fonts/icons/images via CDP → local files + manifest), `compare_images`,
`show_replica` (load a finished extraction folder into the app's result panel —
the in-app preview; use instead of serving a URL).

## Notes
- Prefer `ax_tree` node `bounds` → `screenshot_region` for pixel-tight crops over
  `screenshot_window` cropping.
- Mask dynamic content (clocks, unread badges) mentally when reading the score; a
  perfect static replica may still show small red regions there.
- If `compare_images` scores low even on a good replica, re-check you rendered at
  **point** size (not device px) — that's the #1 cause.
