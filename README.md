# Cheater

Point at any element on any website, click it, and get back a **standalone HTML file that
renders identically offline** plus a **compact TOON spec** to paste into an LLM with
"rebuild this in React + Tailwind".

Manifest V3. Vanilla JavaScript. No build step, no bundler, no npm, no frameworks, no CDN
scripts at runtime. The ZIP writer, the syntax highlighter and both serializers are
implemented in this repo.

---

## Install

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this folder

That's it — no build, no install step. The repo folder *is* the extension.

## Use

Click the toolbar icon. Selection mode activates immediately; the popup is only there for
buttons and settings.

- **Hover** — the element under the cursor is outlined in red, with a label naming its tag,
  meaningful classes and pixel size, so you know exactly what you'd get.
- **Click** — a small leaf (a bare `<input>`, an icon, an overlay button, a heading) expands
  to the **nearest meaningful container**: the field card, the chip, the card. Anything that
  already looks like a component is taken as-is. Selection happens on *pointer down* and the
  rest of the interaction is swallowed, so clicking a link or a menu button selects it instead
  of navigating or opening the menu.
- **Opt/Alt+Click** — skip expansion, take the exact element.
- **Shift+Click** — multi-select. Clicking a selected element deselects it.
- **Opt/Alt+↑/↓** — move the **selection** to its parent or child, live-previewing each step.
  A back-stack means overshooting upward is always reversible: four presses up and
  four presses down land exactly where you started. Moving the mouse does not
  disturb what the arrows are traversing.
- **Opt/Alt+Scroll**, or plain scroll while pointing *at your current selection* —
  walk the tree the same way. Plain scrolling anywhere else leaves the page
  scrollable, so you can still reach things below the fold.
- **Export** — a new tab opens with Preview / HTML / TOON, diagnostics, and save buttons.

After every save the **absolute file path is copied to your clipboard**, so you can paste it
straight into Claude Code.

### Shortcuts

All seven main shortcuts are customizable in the popup and persist via `chrome.storage.sync`.

| Action | macOS | Windows / Linux |
|---|---|---|
| Start selection | `Cmd+Shift+S` | `Ctrl+Shift+S` |
| Clear selection / exit | `Escape` | `Escape` |
| Export selection | `Cmd+Shift+E` | `Ctrl+Shift+E` |
| Extract full page | `Cmd+Shift+X` | `Ctrl+Shift+X` |
| Recent captures | `Cmd+Shift+H` | `Ctrl+Shift+H` |
| Select ⇄ Interact mode | `Cmd+Shift+P` | `Ctrl+Shift+P` |
| **Grab what you hover** | `Cmd+Shift+G` | `Ctrl+Shift+G` |
| Diagnose what is visible | `Cmd+Shift+D` | `Ctrl+Shift+D` |
| Exact target (no expansion) | `Opt+Click` | `Alt+Click` |
| Multi-select | `Shift+Click` | `Shift+Click` |
| Parent / child of the selection | `Opt+↑` / `Opt+↓` | `Alt+↑` / `Alt+↓` |
| Walk the tree | `Opt+Scroll` | `Alt+Scroll` |

`Escape` is only intercepted while Cheater is active with something to clear — the page's own
Escape handling is never disturbed.

---

### Interact mode — driving the page while Cheater is on

Selection mode swallows clicks, which is what stops a click from navigating instead of
selecting. The side effect is that you cannot *operate* the page while it is on: clicking a
dropdown selects the trigger, tabs will not switch, and nothing that has to be **opened** can
be reached.

The toolbar in the bottom corner has two modes, and `Cmd/Ctrl+Shift+P` toggles them:

- **Select** — clicks select elements. The default.
- **Interact** — clicks belong to the page. Menus open, links follow, inputs type, `Escape`
  reaches the page's own handlers. Nothing is intercepted.

Two things stay live in interact mode, and they are what make it a mode rather than an off
switch:

**The outline keeps following your cursor**, restyled amber and dashed so the mode is obvious
at a glance. It is the only thing telling you what would be captured.

**`Cmd/Ctrl+Shift+G` grabs whatever you are pointing at**, with no click at all. That is not a
convenience — it is the only gesture that can capture a **hover-revealed** menu. Such a menu
closes the instant the pointer leaves it, so clicking it, or reaching for a button, destroys
the thing being captured. A key does not move the pointer.

So the flow for anything that has to be opened is:

1. `Cmd/Ctrl+Shift+P` — switch to Interact
2. Open the menu, or just hover it
3. `Cmd/Ctrl+Shift+G` — grab it. The cursor never moves, so the menu stays open
4. Export

Grab uses the same smart expansion a click does, so pointing at a menu row still gives you
the menu; hold `Alt` for the exact node. The toolbar keeps out of the cursor's way — it is the
one layer that accepts pointer events, so it hops to the other side rather than making
whatever sits beneath it unhoverable. The badge turns blue in interact mode, because there a
click is a real click.

### iframes

An iframe used to become a flat screenshot crop — **including same-origin ones**. It looked
right in the preview and carried no DOM at all, so the TOON handed an LLM a placeholder and
"rebuild this in React" had nothing to work from.

A same-origin frame is readable, so it is now walked like any other subtree. The one thing that
makes it work is treating the frame's **document** as its own scope, exactly the way a shadow
root already is: `querySelectorAll` does not cross a frame boundary any more than it crosses a
shadow boundary, and the frame's rules live in its own `document.styleSheets`. Register the
frame document as both a style source and a query scope and the existing machinery — computed
styles, the hover index, `@font-face` discovery — just works, because all of it is
element-driven.

The **whole** frame document is captured, not the part that happened to be visible — so the
exported box has to stay scrollable, or everything past the first screenful is present in the
markup and unreachable in the render. An iframe scrolls; a `<div>` with `overflow:hidden` does
not. A frame that genuinely cannot scroll (`scrolling="no"`, or an `overflow:hidden` document)
keeps `hidden`, so a deliberately clipped banner or ad slot does not sprout a scrollbar it never
had.

Four details that are easy to get wrong:

- The frame is exported as a `<div>`, not an `<iframe>`. An `<iframe>` in the saved file would
  reload the live URL rather than show what was captured — and would need the network.
- The frame's root is a `<body>`, and a **nested `<body>` start tag is discarded by the HTML
  parser**, with its attributes merged onto the document's real body. Left alone, the frame's
  background and padding would tint the whole export while the frame box lost them. It is
  retagged to a `div`.
- A frame's backdrop is often on its `<html>`, not its `<body>`. CSS propagates that to the
  canvas, and there is no canvas once the frame is a div — so it is carried onto the box
  explicitly, or the frame renders transparent and the host page shows through it.
- Rects inside a frame are relative to the **frame's** viewport, not the page's. Pixel recovery
  crops from a screenshot of the top document, so the frame's offset is added or every crop
  inside a frame samples the wrong region.

Nesting is followed three levels deep, which is past anything real and stops a hostile page
turning one capture into a fork bomb.

### Menus that live outside the component

A modern dropdown does not put its menu inside its trigger. React, Radix, MUI and most
design systems render it through a **portal** — appended to `<body>` and positioned over
the trigger — so the menu is not a descendant of anything you would think to select.
Walking the trigger's subtree therefore finds no menu, which is why real-world dropdowns
exported empty even when they were open on screen.

So the capture looks *outside* the selection, most reliable signal first:

| How it's found | What it catches |
|---|---|
| `aria-controls` / `aria-owns` / `popovertarget` | the component tells us exactly which element it controls |
| **reverse** `aria-labelledby` / `aria-controls` pointing *into* the selection | libraries that wire it the other way round, with the menu naming its trigger |
| `aria-describedby` | tooltips and help bubbles |
| `:popover-open` | native popovers |
| `dialog:modal` | `showModal()` dialogs, which live in the top layer |
| **it appeared since you started pointing here**, next to the element or one of its containers | hover cards, chart tooltips and sidebar mega-menus, none of which carry any ARIA relationship |
| **a floating layer under the pointer** | a tooltip already in the DOM and merely revealed by CSS, where there is no mutation to see |
| geometry — a positioned layer horizontally overlapping and vertically adjacent | everything else, and **only** when the selection actually has something open |

Each candidate must be visible, outside the selection, and smaller than 60% of the
viewport (90% when the component named it explicitly) — a layer covering the page is a
backdrop, not this control's menu. Adoption is capped at four per selection, searches
shadow roots as well as the document, and each adopted menu appears as its own
diagnostics row with an `adopted · <how>` badge so it is never a silent guess. Their
absolute offsets are neutralized, so a menu sits under its trigger in the export instead
of pinned to a corner of `<body>`.

A plain `<dialog open>` is deliberately *not* adopted: it sits in normal flow and would
otherwise attach itself to every unrelated capture on the page. And the geometry pass —
the only one that guesses — skips any layer that already declares its own trigger, or that
some other trigger on the page points at. On a filter bar with several menus side by side,
proximity alone will happily hand you the neighbour's menu.

### Closed dropdowns

Most of the time you point at a dropdown its menu is **closed**, and a closed menu is
`display:none`. Hidden subtrees were dropped, so the menu was never in the capture at all —
which is the real reason an exported dropdown had nothing to open, whatever the export did
with it afterwards.

A subtree that looks like a menu (a menu/listbox role, or a menu-ish class, id or test id)
is now **briefly revealed on the live page**, captured, and put back. That matters more than
it sounds: a `display:none` subtree has no geometry at all, so every rect inside it reads
0x0 and any icon in a menu row would export as a zero-sized hole. Reading it while it is
laid out is the only way to capture it faithfully.

Unhiding walks a ladder, stopping at the first rung that works: the `hidden` attribute and
inline `display`/`visibility`/`opacity`; then removing the one class that hides it, trying
state-looking names (`is-collapsed`, `js-hidden`, `d-none`) before styling ones — that beats
forcing a value, because it lets the real cascade produce the menu's true open layout even
when the page hid it with `!important`; and only failing that, a forced `display:block`.
Everything is restored in a `finally`, including the exact inline priority. The menu may
flash visible for a few milliseconds.

This is the one place the extension touches the page's own elements, and it is deliberately
the narrow version: it changes only the declarations doing the hiding and fires **no
events**, unlike synthetic clicks, which can submit forms, navigate, or hit destructive
controls. It is capped at six menus per capture, and hidden subtrees that are *not*
menu-shaped stay dropped — capturing every hidden thing on a page would bloat exports and
carry along content nobody selected.

### Hover cards and chart tooltips

The hardest case, and the one every earlier signal misses. A treemap tile's card — the
PitchBook/Highcharts shape — is portal-rendered at `<body>` level, positioned next to the
cursor, carries **no ARIA relationship** to the tile, and its trigger has no `aria-expanded`
anywhere. So explicit wiring finds nothing, and the open-trigger gate stops geometry from
even running. Grabbing under the cursor gets you the tile, not the card.

The only honest evidence is **"this appeared while I was pointing here"**, so that is
recorded: while selection mode is active, a `MutationObserver` notes floating layers as they
show up. At capture time, any layer that appeared in the last six seconds and is placed like a
tooltip — near the pointer, or overlapping the element — is adopted alongside the selection.

It is kept cheap and kept honest:

- Candidates are prefiltered with a **string test**, not a selector match — running a large
  selector against every mutation on a busy app would cost more than the feature is worth. The
  strongest structural signal is free: portals are appended directly to `<body>`.
- Recency alone is never enough. A notification toast in the far corner that appeared at the
  same moment is rejected on placement, and any layer that is or contains a **landmark**
  (`header`, `nav`, `main`, `footer`) is rejected outright as page furniture.
- The observer runs only while selection mode is on, and its attribute filter is narrow.
  Whole-page capture of the 9,000-rule stress fixture still completes in ~120ms.

**Grab captures what appeared, not what you pointed at.** You hover a nav link in order to see
its flyout; the flyout is the thing you want and the link is just how you got there. So when a
layer appeared for this hover, that layer becomes the selection on its own. Hold **Alt** to take
exactly what is under the cursor instead, panel excluded.

In practice: switch to **Interact**, hover until the panel appears, then `Cmd/Ctrl+Shift+G`. The
pointer never moves, so the panel stays up.

**Placement is measured against the element's containers, not just the element.** A sidebar
mega-menu is the case that forces this: the link you hover is narrow and indented, so the panel
opens beside the **rail** and can sit 200px+ from the link and nowhere near the pointer.
Measured against the link it looks unrelated; measured against the rail it is obviously its
flyout. The walk up is capped by *size* rather than depth — a page-sized ancestor adjoins
everything, so anything above 60% of the viewport stops it.

**Recency is measured from when the hover began**, not on a wall clock. A layer only counts if
it appeared *after* you started pointing at this element. Getting that wrong meant every layer
the page built at load time qualified, which over-adopted badly — the existing portal fixtures
caught it immediately.

**Grab is broadcast to every frame, not handled where the keystroke lands.** `composedPath()`
does not cross a frame boundary, so when the cursor is inside an iframe the top frame sees no
hover at all — no pointer, no hovered element, and its `MutationObserver` never sees the card
because the card lives in the frame's own document. Meanwhile the keystroke goes to whichever
frame holds keyboard *focus*, which is the top one. Those are different frames for any chart
embedded in an iframe, so every frame is asked and the one whose pointer is over something
answers. Without this, an in-frame hover card was silently uncapturable.

### When hover capture doesn't work: `Cmd/Ctrl+Shift+D`

Every failure mode here looks identical from the outside — nothing happens. The diagnose key
prints a report to the console and copies it to the clipboard, naming which frame you are in,
whether the pointer is being tracked at all, every floating layer it can see, and **why each
one was or was not adopted**:

```
cheater: 3.1.0 · interact mode
frame: TOP https://example.com/chart
pointer: 170,255
hovered: div.tile.big [292x150 @ 24,180]
layers seen appearing: 1
element at pointer: div.tile.big [292x150 @ 24,180]

floating layers in this frame: 13
  div.hovercard [380x207 @ 182,267] -> WOULD BE ADOPTED
  div.menu [224x119 @ 37,-914] -> not visible
  ...
adoption result: div.hovercard [380x207 @ 182,267] (appeared on hover)
shadow roots known: 0
same-origin frames seen: 0
```

It also calls out the two cases nothing can fix: a pointer over a `<canvas>` (a canvas-drawn
tooltip has no DOM at all — pixels are the only option) and a pointer over a cross-origin
`<iframe>` (that frame owns the hover).

### Dropdowns you can actually open in the export

Both kinds of captured menu — a closed one revealed during the walk, and an open portal one
adopted from outside — end up expressed the same way: a **host**, a **trigger** and a
**menu** sharing one id. The export tab's **Static / Interactive** toggle (shown only when
there is a dropdown to open) hides the menu and reveals it on `:focus-within`.

An in-tree menu needs no wrapper at all: its host is a real captured element, and the
nesting the page already had is what positions the menu. Only an adopted portal menu gets a
synthetic host, because the trigger and the menu are separate top-level selections with no
common ancestor in the export. Rules are scoped per pair, so two dropdowns side by side stay
independent and a nested one cannot be opened by the outer one's focus.

Clicking the trigger focuses it, the wrapper matches, the menu appears; clicking anywhere
else moves focus away and it closes. A trigger that is not natively focusable — a styled
`<div role="button">`, which is the common case — gets a `tabindex`, which also makes the
dropdown keyboard-reachable.

A closed `<details>` gets the same treatment on engines that hide its content with
`display:none`, so the export is not an empty disclosure widget — but it is left as a real
`<details>`, since it is already interactive and needs no help. Current Chrome lays that
content out anyway, so there the check is a no-op and the page is not touched.

**No JavaScript ships.** That is the constraint that picked the mechanism, not a bonus: the
preview iframe runs without `allow-scripts` on purpose, and a saved export should stay inert
rather than carrying executable code lifted off someone's page. The menu's captured `display`
is carried into the open state too, so a flex or grid menu does not reopen as a `block` and
collapse its own layout.

Two things it does not do. Clicking the trigger a second time will not close the menu, since
focus stays where it is. And TOON is never interactive — the wrapper and its rules are
scaffolding, and scaffolding in an LLM handoff reads as noise.

**Native `<select>` is the one genuine dead end.** Its `<option>` list is real DOM and
comes along, so the control works in the export — but the open popup is drawn by the
operating system and exists nowhere in the document. Nothing can capture it.

### When something goes wrong

Every failure names its cause. `chrome.runtime.lastError` is read on every message (it is
the only place an oversized message or a torn-down worker is reported), the payload size is
included since that is the likeliest cause for a large capture, every async worker handler
answers with a reason rather than letting a rejection close the port silently, and the full
line is written to the page console for copying. A torn-down MV3 worker rejecting the first
message is retried once, because that is normal platform behaviour rather than a fault.

### Long captures

Extracting a whole page walks tens of thousands of nodes reading computed styles. A
progress panel reports the percentage as it goes, and the walk yields a frame at a
time so the page never locks up. The export tab then shows its own staged progress
while it builds the HTML, the TOON, the diagnostics, the highlighting and the preview.

If a capture is still running, a second click is ignored rather than interleaved —
two walks writing to one selection set would produce a half-built export.

## What gets captured

Each of these is a separate capture path, and each one is covered by the test suite.

| Module | How it's handled |
|---|---|
| **Shadow DOM** | Open roots are selected, hovered and exported, including **nested** roots. `<slot>` is expanded to its projected light-DOM content, so the flattened tree matches what the browser draws. Hit testing uses the composed event path, and parent traversal crosses the shadow boundary to the host. |
| **iframes / frames** | A **same-origin** frame is walked like any other subtree: its real markup, its own stylesheets and its own `@font-face` rules all come into the export, nested frames included. A **cross-origin** frame cannot be read from the page at all, so it degrades to cropped pixels. Separately, commands broadcast to every frame, so a selection made *inside* a frame is exported from there and multiple frames merge with per-frame class namespacing. |
| **`<canvas>`** | The live bitmap is snapshotted into a same-sized image. Cross-origin-tainted canvases and WebGL contexts without `preserveDrawingBuffer` (which read back fully transparent rather than throwing) degrade to a correctly-sized placeholder. |
| **SVG** | Inline SVG is preserved whole with its rendered size and fill pinned. `<use href="#id">` sprite references are resolved into a local `<defs>`, following nested `<use>` inside a resolved symbol. Gradients, `clipPath` and filters come along. Purely decorative empty SVGs are dropped; stroke-only icons are not. |
| **CSS mask / background icons** | The full `mask-*`, `-webkit-mask-*` and `background-*` sets are captured, so toolbar and ribbon glyphs survive. |
| **Icon fonts** | Material Icons, Material Symbols, Font Awesome 4/5/6, IcoMoon, Glyphicons, Bootstrap Icons, Segoe Fluent Icons, and families ending in "Icons". Ligature settings are applied and the right stylesheet linked, including for `::before`-delivered glyphs. |
| **Private icon fonts** | An application's own icon font usually has no `@font-face` to find — loaded through the JS `FontFace` API, or from a CORS-restricted stylesheet — so there is nothing to bundle and nothing safe to link. Those glyphs are **rendered to images at 2x** so they still display. See below. |
| **Web fonts** | Every family the capture *actually uses*, with the exact weights and italic variants observed. |
| **Self-hosted fonts** | `@font-face` rules are discovered, URLs resolved against the stylesheet, the best format chosen (woff2 > woff > otf > ttf), and the binaries bundled into a zip. |
| **Images** | The source the browser is actually displaying (`currentSrc`, i.e. the chosen `srcset`/`<picture>` candidate after a lazy-loader swap). Untainted bitmaps are inlined; images with no resolvable source are dropped and counted. |
| **Form controls** | Live state, not markup defaults: `value`, `checked`, `selected`, `disabled`, `readonly`, `required`, `multiple`, `hidden`, `<details open>`, `placeholder`, `type`, `aria-label`. |
| **Pseudo-elements** | `::before` and `::after` captured independently as real `.pN::before` / `.pN::after` rules — including purely decorative ones with empty `content` (dividers, toggle handles, custom checkbox marks) with their shadow, transform and positioning intact. |
| **Hover states** | The difference between resting and hover appearance, emitted as `:hover` rules. Also handles ancestor hover (`.card:hover .button`). |
| **Dynamic content** | The subtree is frozen at selection time, so carousels, tickers and rotating tips export exactly as they looked when you clicked. |
| **Also** | dropdowns and open menus, dialogs, tabs, breadcrumbs, sticky/fixed elements, badge overlays, floating labels, CSS custom properties, gradient text, CSS counters, RTL, ellipsis, multi-column, transforms, `range`/`progress`/`meter`, scrollbar styling, `backdrop-filter`, line clamping. |

### Pixel recovery — the universal fallback

Some things cannot be reproduced from source at all: a cross-origin-tainted canvas, a
closed shadow root, a cross-origin iframe, an icon whose font cannot travel, an external
SVG sprite reference. In every one of those the browser can see the pixels and the
extension cannot see the source.

So when a node cannot be represented, its region is cropped out of a single screenshot of
the tab (`chrome.tabs.captureVisibleTab`) and becomes a plain `<img>` at device resolution.
One screenshot per export, cropped N times, with Cheater's own overlay hidden first so the
hover outline is not photographed into the export.

It also fires speculatively, which is the point: a box that occupies icon-sized space and
paints *nothing* is a hole in the export whatever caused it — a glyph from a font nobody
detected, a technique nobody has thought of. Rather than shipping the hole, the pixels are
recovered. Two guards keep that from running wild: the speculative trigger only applies to
small, roughly-square boxes (so legitimate layout spacers are left alone), and a crop that
turns out to be a single flat colour is discarded rather than emitted as a pointless PNG.

The diagnostics panel reports how many elements were recovered this way, because an image
is not markup and you should know which parts of an export are which.

### Recent captures

The last **10 exports** are kept, and reachable three ways: the **Recent captures** section in
the popup, `Cmd/Ctrl+Shift+H`, or the **History** button in an export tab. Nothing is stranded
behind "do another export first".

The popup shows age, what was selected and the host, with the count visible while the section
is collapsed; clicking a row opens it in an export tab. The export tab's panel adds the full
URL, pixel size, node count, bytes, and per-entry delete. Opening one
re-renders the whole tab from it through exactly the same path as a fresh capture; entries
can be deleted individually or all at once.

Stored in IndexedDB rather than `chrome.storage.local`, because the permission set has no
`unlimitedStorage` and storage.local caps out at 10 MB — a handful of captures with inlined
bitmaps clears that easily. Summary rows live in a separate store from the payloads so the
list draws without deserializing megabytes. Pruning is by count *and* a 60 MB total budget,
whichever bites first.

### What it can't do

These are all cases where the *source* is unreachable. Pixel recovery (above) means they
still **look** right — as images rather than markup — provided the element was on screen.

- **Closed shadow roots** are unreachable from an extension's isolated world. Nothing can be
  captured inside `attachShadow({ mode: 'closed' })`.
- **Cross-origin iframes** cannot be read from the parent page — the browser forbids it, and
  no extension trick changes that. They become cropped pixels: right-looking, but no markup.
  Capturing the frame in its own tab gets the DOM. A `sandbox` attribute without
  `allow-same-origin` has the same effect even on your own URL, since sandboxing forces a
  unique opaque origin.
- **Cross-origin-tainted canvases** cannot be read, by browser security design.
- **External sprite files** (`sprite.svg#icon`) resolve only when the symbol is in the
  document; a separate file is not fetched.
- Anything **scrolled out of view** cannot be pixel-recovered — a screenshot only sees the
  visible viewport.
- **`chrome://`, `chrome-extension://`, `about:`, `data:`, view-source and the Web Store**
  block all extension content scripts. The popup says so explicitly instead of failing quietly.

---

## Output 1 — standalone HTML

A single `<!DOCTYPE html>` file that opens in any browser. It contains font and icon
stylesheet links for exactly the families detected, a bundled `@font-face` block when
self-hosted fonts were captured, all captured styles as shared classes plus `:hover` and
`::before`/`::after` rules, and a normalizing reset.

The reset matters more than it sounds. Once a page's own CSS is gone, user-agent styles
resurface: default margins on headings and paragraphs, bold 2em headings, `<fieldset>` groove
borders, `<hr>` inset borders, the native `<select>` triangle sitting underneath a page's
custom chevron. It neutralizes all of that, and critically makes inputs **inherit** font,
letter-spacing and line-height — browsers don't, and that alone shifts every field's text
metrics — while leaving checkbox, radio, range, color and file inputs their native chrome so
they stay visible.

The whole reset is written inside `:where()`, giving it zero specificity, so captured class
rules always win without a single `!important`.

## Output 2 — TOON

Token-Optimized Object Notation: compact, readable, and cheap to feed an LLM.

```
## Meta
url: https://example.com/search
fonts: Inter:400,600i; JetBrains Mono:400,700

## Styles
.s1: display: flex; align-items: center; gap: 8px; padding: 10px 12px

## Hover Styles
.s2:hover: background-color: #27272a
.s1:hover .s2: opacity: 1

## Pseudo Styles
.p1::before [content="\e5cd"]: font-family: Material Icons; font-size: 18px
.p2::after [content=""]: position: absolute; box-shadow: 0 0 0 2px #FFB224

## Structure
div.s1 {
  button.s2.p1 (aria-label="Search" type="button" icon) "Search"
  input.s4 (placeholder="Where to?" value="Las Vegas, NV")
  "Best price, "
  em.s5 "guaranteed"
  " daily"
}
```

Order per node: tag → `.styleClass` → `.pseudoClass` → `[inline overrides]` → `(attributes)`
→ `"text"` → `{ children }`, two-space indent. Bare quoted lines are standalone text nodes,
which is how interleaved text keeps its position. Boolean attributes appear as bare flags.
**Embedded base64 payloads are truncated to their data-URI prefix plus a byte count** — they
are useless to an LLM and would consume the entire token budget. The HTML keeps the full
payload, so the preview still renders.

## The export tab

- **Preview** — live render on a dot-grid canvas in a sandboxed iframe that auto-sizes to its
  content, with a **Fit / 1280 / 768 / 375** width toggle and a light/dark surface toggle.
- **HTML / TOON** — syntax-highlighted source, copy button, byte size, detected primary font.
  Highlighting is skipped above 400 KB so a full-page export doesn't jank the tab.
- **Diagnostics** — summary pills (selections, parent-wraps, nodes dropped, shared styles,
  pseudo styles, hovers, icons, fonts bundled, font failures, canvas gaps, images dropped)
  and one row per selection with its tag, classes, pixel size and position. Every number
  comes with a note explaining what to *do* about it, which is what makes a wrong export
  debuggable instead of mysterious.
- **Downloads** — `Save .html`, `Save .toon`, `Save Both`, and `Download fonts (N)` when
  binaries were bundled. Defaults: `preview.html`, `component.toon`, `preview-fonts.zip`.

**Unzip `preview-fonts.zip` next to the saved HTML.** The zip's entry names are exactly the
paths the saved HTML references, so unzipping alongside it makes the export render offline
with the real fonts and matching text widths.

---

### Icons whose font can't travel

The question is always: **can the export supply the family this element names?** CSS matches
fonts by name, so nothing else counts.

Text survives only when the `@font-face` is discoverable (the binary gets bundled) or the
family name is *exactly* what a public CDN serves. Recognising a family as Material-ish is
not enough — and this is the trap. `"Google Material Icons"` looks like a Material family,
but the CDN serves `"Material Icons"`; those names do not match, so the element falls back
and the glyph is lost either way: a private-use codepoint renders as nothing, and a ligature
renders as the literal word `undo`. That alias, with a private build behind it, is what made
the Google Sheets toolbar export blank.

Everything that cannot travel is rasterized instead — and if rasterizing fails too, the
region is recovered from a screenshot.


An icon only survives as *text* if the font can come with it: its `@font-face` is
discoverable (so the binary gets bundled), or it is a named family with a public CDN
stylesheet (Material Icons, Font Awesome, Bootstrap Icons …), where codepoints are
canonical.

Applications with their own icon set satisfy neither. Google Sheets is the case that
prompted this: its toolbar font is registered from JavaScript, so no CSS rule exists to
discover, and the family name means nothing to any CDN. Every toolbar icon exported blank
while the text beside it came through fine.

For those, **the glyph is rasterized** — drawn to a PNG at device-pixel-ratio (floor 2x)
and emitted as a plain `<img>`, or as a `background-image` when it came from a
`::before`/`::after`. If we cannot ship the font, we ship the pixels. Rasterizing is
strictly the fallback, because text stays scalable, recolourable and greppable; a portable
ligature from a known family is always kept as text. The diagnostics panel reports one row **per icon family**: the family name, whether the glyph
was a ligature or a private-use codepoint, and what was decided (`bundled`, `linked`,
`rasterized`, `lost`). When icons come out wrong that row is the fact that identifies the
cause — inferring it from the outside cost several rounds. Rasterizing also refuses to emit a
blank image rather than claim a success it did not achieve.

CSS sprite-sheet icons (`background-image` plus `background-position`) need none of this —
they are captured as-is.

## Fonts, in detail

Getting "the same font in, the same font out" right needs three different routes, and picking
the wrong one is silently wrong rather than broken:

- **Google-hosted families** are **linked**, not bundled. They're recognized by reading the
  page's `fonts.googleapis.com` link hrefs — the stylesheet contents themselves are
  unreadable, because a plain `<link rel="stylesheet">` is fetched in no-cors mode and
  `cssRules` throws no matter what CORS headers come back.
- **Genuinely self-hosted families** are **bundled** as binaries. The service worker fetches
  them (a content script can't read font files reliably cross-origin) and the export tab
  produces an inline-font preview, a small saved file referencing sibling paths, and the zip.
- **System and generic families** (`system-ui`, `-apple-system`, `Segoe UI`, `Arial`,
  `Roboto`, emoji fallbacks, generic keywords) are **never fetched**.

Each family gets **its own `<link>`**. A single combined `css2` request returns **HTTP 400 in
its entirety** if any one family isn't hosted on Google Fonts, so one unrecognized family
would otherwise cost every other family its webfont.

Availability is decided by **measuring text**, not by asking `document.fonts.check()` — that
API answers "can this text be rendered?", which is `true` for a completely unknown family
because the browser falls back. A family that isn't really there measures identically to its
generic fallback, and is skipped.

The UI reports the **primary font** and warns when it isn't auto-loadable, because fallback
metrics changing text widths is the usual cause of "the export looks like it overflows but the
original didn't".

---

## Node CLI

```
node scripts/toon-to-html.js input.toon [output.html]
```

Converts a saved `.toon` back into HTML through the **same** `lib/toon-writer.js` parser and
`lib/html-writer.js` emitter the extension uses, so the output is identical by construction
rather than by hand-maintained duplication. Useful for diffing captures across versions. Zero
dependencies. Use `-` as the output path for stdout.

Truncated base64 payloads can't be reconstructed and render as labelled placeholder boxes; use
the `.html` export when you need the pixels.

---

## Permissions

| Permission | Why it's needed |
|---|---|
| `activeTab` | Act on the tab you have open when you click the toolbar icon. |
| `scripting` | Injection support for the content script that draws the selection UI and reads computed styles. |
| `webNavigation` | Enumerate a tab's frames (`getAllFrames`) so commands reach every frame and the export can come from whichever one holds a selection. |
| `storage` | Persist your custom shortcuts (`storage.sync`) and stage the export payload for the export tab (`storage.session`). |
| `downloads` | Save `preview.html`, `component.toon` and `preview-fonts.zip`, and read back the absolute path so it can be copied to your clipboard. |
| `clipboardWrite` | Copy the saved file's path, and the HTML/TOON source from the copy button. |
| `<all_urls>` (host) | Capture works on any site you point it at, and lets the service worker fetch `@font-face` binaries from whatever host serves them. |

No remote code execution, no analytics, and no network requests other than fetching font
binaries the page itself already uses. Nothing is ever sent anywhere.

---

## Layout

```
manifest.json
background.js            service worker: frame fan-out, font fetch, payload handoff
contentScript.js         all frames: selection UI, expansion, navigation, capture
popup.html / popup.js    toolbar popup, auto-starts selection, shortcut editor
export.html / export.js  export tab: preview, diagnostics, downloads
lib/reset.js             the :where() reset — also the capture's pruning baseline
lib/html-writer.js       payload -> standalone HTML   (shared with the CLI)
lib/toon-writer.js       payload <-> TOON             (shared with the CLI)
lib/zip.js               store-only ZIP writer + CRC-32
lib/highlight.js         escape-first, single-pass syntax highlighter
scripts/toon-to-html.js  Node CLI
test/fixtures.html       every module type on one page
test/run-fixtures.js     189 capture assertions
test/dropdowns.html      twelve shapes of closed dropdown
test/iframes.html        nine iframe shapes, incl. a real second origin
test/run-iframes.js      71 iframe assertions
test/run-dropdowns.js    131 dropdown, interact-mode, hover-card + flyout assertions
test/frame-tooltip.html  a chart with a hover card, inside a frame
test/run-fonts.js        34 font-fidelity assertions
test/cdp-runner.js       runs the browser suites against headless Chrome, no deps
```

`lib/*.js` are classic scripts with a UMD-ish tail, so the same file runs in the content
script, in the extension pages, and under `node` — which is what keeps the CLI and the
extension emitting byte-identical HTML.

### Two design decisions worth knowing before editing

**The reset is the pruning baseline.** The capture drops any computed value equal to the
element's default, so the export doesn't restate 340 properties per node. That's only sound if
the baseline is the value the element will have *in the exported document* — user-agent styles
as modified by `lib/reset.js`. So the content script injects `RESET_CSS` into a hidden probe
iframe before reading defaults. Change a rule in the reset and the pruning baseline moves with
it automatically. Corollary: only reset **non-inherited** properties freely.

**Capture is two-phase.** `captureRaw()` runs at *selection* time and reads everything it will
ever need from the DOM. `finalize()` runs at *export* time and touches no DOM at all. That
split is what freezes dynamic content — by export time the live DOM may have moved on, and
nothing in `finalize()` cares.

**Rule matching is inverted, and it has to be.** The obvious way to find which CSS rules
apply to an element is to test each element against every rule — which is
O(elements x rules), and real applications make that fatal rather than merely slow. On a
page with ~9,000 rules and ~1,200 elements that is 11.2 million `matches()` calls, measured
at **~4.8 seconds**; a real application page is several times larger again, which is why a
YouTube Music capture appeared to hang outright. `buildMatchIndex()` instead runs one
`querySelectorAll` per rule over the selected subtree — **31ms for the same page, ~150x
faster** — and hands the matching to the selector engine, where it belongs. Anything added
that needs per-element rule data belongs in that index, not in a per-element loop.

---

## Tests

```bash
node test/cdp-runner.js                 # every browser suite
node test/cdp-runner.js run-fixtures    # just one
node test/run-worker.js                 # the Node-only worker suite
```

`cdp-runner.js` launches headless Chrome itself, serves the repo on port 8931, and shims the
handful of Playwright `page` methods the harnesses use over the DevTools protocol. Zero
dependencies, like the rest of the repo. The suites are still plain Playwright
`async (page) => {…}` functions, so they also run through a Playwright MCP server
(`browser_run_code_unsafe` with `filename`) against a manually started
`python3 -m http.server 8931 --bind 127.0.0.1`.

They load the real content script into `test/fixtures.html` with a stubbed `chrome` API and
assert one capture path at a time.

Seven suites:

- **`test/run-history.js`** — 13 assertions over the capture-history store, run in a page
  where IndexedDB behaves as it does in the worker. Covers ordering, pruning by count and by
  byte budget, payload round-trip and deletion.


- **`test/run-worker.js`** — 16 assertions, plain Node (`node test/run-worker.js`), no
  browser. Loads `background.js` against a stubbed `chrome.*` and drives the export path.
  This one exists because a worker failure reaches the page as nothing but "Export failed":
  the worker has no console anyone watches, and a rejected promise in a message handler
  simply closes the port with no response at all.


- **`test/run-dropdowns.js`** — 131 assertions over `test/dropdowns.html`, which holds fourteen
  shapes of **closed** dropdown: hidden by inline `display`, by `visibility`, by the `hidden`
  attribute, by a stylesheet class with `!important`, a menu of links, a non-focusable div
  trigger, a menu nested deeper than its trigger, twin dropdowns that must stay independent,
  native `details`, and a hidden non-menu that must stay dropped. Assertions are behavioural:
  each export is rendered under export.html's sandbox and focus is moved to check the menu
  opens, has real height, sits under its trigger and closes again. It also asserts the live
  page is left exactly as it was — a menu stuck open on someone's site would be the worst
  possible failure here. The last block covers interact mode with a **real cursor**: the
  driver moves the actual pointer (synthetic events cannot, so `:hover` never matches), the
  hover-only menu genuinely appears, and it is captured with the grab key without a single
  click. The last block covers the chart-tooltip shape: it first asserts that every other
  adoption signal genuinely fails on that fixture — no ARIA wiring, no open trigger — so the
  test cannot pass for the wrong reason, then checks the card is adopted, and that an unrelated
  toast and a landmark-bearing layer are both rejected.
- **`test/run-iframes.js`** — 71 assertions over `test/iframes.html`: `srcdoc`, a same-origin
  URL, a **genuinely** cross-origin frame (the runner serves a second origin on port 8932 so it
  is real rather than simulated), nested frames, `about:blank` written by script, a sandboxed
  opaque origin, a scrolled frame, a frame as the capture root, and a full document four times
  taller than its frame — where all 20 rows and the footer past the fold must be captured, and
  the rendered box must genuinely scroll to reach them. Ends with a fidelity comparison: the
  same element's computed style read in the original frame and in the rendered export and
  required to match, including rendered text width. A final block puts a hover card **inside**
  a frame and asserts the top frame genuinely cannot see it while the frame's own instance can
  — the fact that forces grab to be broadcast.
- **`test/run-fixtures.js`** — 189 capture assertions over `test/fixtures.html`, one per
  capture path. The interactive-dropdown assertions at the end are behavioural rather than
  textual: the generated export is rendered in an iframe carrying **the same sandbox
  attribute `export.html` uses**, a canary script confirms scripts really are blocked, and
  then focus is moved to check the menu actually opens and closes.
- **`test/run-fonts.js`** — 34 font-fidelity assertions. Verifies fonts by measuring
  **rendered text width** in the original and in the export and requiring them to match: a
  different font file means different advance widths, so there is nowhere to hide.
- **`test/run-stress.js`** — 22 assertions over `test/stress.html`, a 9,000-rule stylesheet
  with Polymer-shaped controls (custom elements wrapping a real `<button>`, a
  `pointer-events:none` icon `<svg>`). Covers capture performance, progress reporting, the
  yield behaviour, overlap rejection, wheel gating and Alt+Arrow anchoring.

Current status: **189/189 + 131/131 + 71/71 + 34/34 + 22/22 + 13/13 + 16/16 = 476 passing**, with every sampled
component rendering pixel-identically to its original and a whole-page capture of the
9,000-rule stress fixture completing in ~100ms.

Two 404s appear in the page console on every fixture run. They are the point: one is the
deliberately broken `<img>` that exercises the images-dropped path.

The harnesses append a cache-busting query to every injected script. Without it Chrome
happily reuses a previously fetched `lib/*.js` between runs, and the suite silently tests
stale code — which it did, once.
