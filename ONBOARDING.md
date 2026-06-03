# VibeExtract — setup for devs

VibeExtract turns a **running macOS app's UI into clean, verified HTML/CSS**. You point it at
any window (or pick one component), and the `/replicate-ui` skill in Claude Code inspects it via
Accessibility + screenshots, harvests the real fonts/icons/images, generates semantic HTML+CSS,
renders it, and diffs the render against the original until they match.

Two pieces work together:

1. **The VibeExtract app** (`VibeExtract Desktop.app`) — a tray/desktop app that reads the native
   UI and runs a small local **MCP server** on `127.0.0.1:8765`. It also owns the global hotkeys
   for picking a component.
2. **The `/replicate-ui` skill + shared helpers** (this repo) — the Claude Code skill that drives
   the perceive → generate → verify loop, plus `.replicate-ui/_shared/` (role map, CSS reset,
   grid-text OCR, the reuse cache).

---

## 1. Install the app

1. Copy `VibeExtract Desktop_0.2.0_aarch64.dmg` (from the shared drive) and open it.
2. Drag **VibeExtract Desktop** into `/Applications`.
3. **First launch:** the app is internally **self-signed** (not from the App Store / not
   notarized), so macOS will block a normal double-click. **Right-click the app → Open → Open**
   in the dialog. You only do this once; afterwards it opens normally.

## 2. Grant the two permissions (once)

VibeExtract reads other apps' UI and captures their windows, so macOS gates it behind two
privacy permissions. Open **System Settings → Privacy & Security** and add **VibeExtract Desktop**
(toggle it **on**) under **both**:

- **Accessibility** — lets it read the Accessibility (AX) tree: roles, labels, bounds.
- **Screen Recording** — lets it capture window/region screenshots (without this, shots are black).

If a permission list already has an old VibeExtract row, remove it with **–**, then re-add the
current app with **+**. Then **Quit & Reopen** the app.

> The app is signed with a stable identity ("VibeExtract Dev"), so these grants **survive app
> updates** — you won't have to re-grant on every new build.

## 3. MCP server — it's automatic

The MCP server **auto-starts when the app launches** (no toggle, no env var). Confirm it's up:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8765/mcp   # 406 = up (rejects plain GET)
```

`406` means the server is running (it only speaks the MCP protocol). To disable autostart for
local debugging, launch with `VIBE_MCP_NO_AUTOSTART=1`.

## 4. Set up the skill workspace

Clone/copy **this repo** to where you'll do replica work — it carries the skill, the shared
helpers, and the MCP registration:

- `.claude/skills/replicate-ui/SKILL.md` — the skill (auto-discovered when Claude Code runs in
  this folder; or copy it to `~/.claude/skills/` to use it everywhere).
- `.replicate-ui/_shared/` — `role-map.json`, `interactive.css`, `gridtext.py`, `vision_ocr`,
  `cache.py` (the reuse cache). The generators reference these by relative path.
- `.mcp.json` — registers **both** MCP servers Claude needs:
  - `vibe-extract` → `http://127.0.0.1:8765/mcp` (the app)
  - `playwright` → headless Chromium for rendering replicas (`npx @playwright/mcp`)

  Edit the playwright `--output-dir` in `.mcp.json` to a path on **your** machine.

Register the servers (if not picked up from `.mcp.json` automatically):

```bash
claude mcp add --transport http vibe-extract http://127.0.0.1:8765/mcp
claude mcp list      # both vibe-extract and playwright should be connected
```

> **After you restart the VibeExtract app, reconnect the MCP in Claude:** run `/mcp` → select
> `vibe-extract` → reconnect. The server restarts with the app, so Claude's old connection goes
> stale until you reconnect.

---

## 5. Use it

### Pick a component with hotkeys (do this on the target app, not on VibeExtract)

Selection is **hotkey-driven** — there are no buttons to toggle. Go to the app you want to capture
and:

| Hotkey | Action |
|---|---|
| **⌘⇧S** | Start picking — hover highlights elements |
| **Click** | Select the hovered element (⇧-click to add more) |
| **⌘⇧E** | Extract the selection (quick in-app preview) |
| **⌘⇧X** | Capture the whole frontmost window |
| **↑ / ↓** | Widen / narrow the hovered element |
| **Esc** | Cancel picking |

(If ⌘⇧S is swallowed by a hotkey manager like Bartender/Magnet, pressing **⌘⇧E** with nothing
picked also arms pick mode.)

### Get a high-fidelity replica with Claude (the real deliverable)

1. On the target app: **⌘⇧S**, then **click** the component you want (or skip selecting to do the
   whole window).
2. Switch to **Claude Code** (in this repo) and run:

   ```
   /replicate-ui
   ```

   - If you **selected** a component, it replicates **only that component**.
   - If you **didn't**, it replicates the **whole window**.

   It produces verified `index.html` + `assets/` under `.replicate-ui/<app>/`, iterating until the
   render matches the original (≥ 0.92 similarity).

### Incremental reuse (similar pages get fast)

The **first** page of an app pays full cost (harvest assets, OCR any grid labels, verify every
component). **Pages 2..N of the same app reuse** the cached fonts/icons/images, grid labels, and
toolbar sprites, and **start from the previous verified page** — so they're much quicker. You
don't do anything special; the skill checks the cache (`.replicate-ui/_shared/cache.py`)
automatically. To see what's cached for an app:

```bash
python3 .replicate-ui/_shared/cache.py <app>     # e.g. slack
```

---

## Troubleshooting

- **"App is damaged / can't be opened"** → it's self-signed; right-click → **Open** the first
  time (step 1).
- **Screenshots are black / AX tree empty** → the matching permission isn't granted; re-check
  step 2, then Quit & Reopen.
- **`/replicate-ui` can't reach `vibe-extract`** → the app isn't running, or you restarted it and
  Claude's connection is stale. Make sure the app is open, `curl` returns `406`, then `/mcp` →
  reconnect.
- **Hotkeys do nothing** → another app may own ⌘⇧S/⌘⇧E. Free them in that app's settings, or use
  the ⌘⇧E auto-arm fallback. Make sure VibeExtract has **Accessibility** (hotkeys + AX both need
  it).
- **A grid of labels (e.g. spreadsheet headers) renders as a blurry image** → that's the OCR
  fallback for baked-in label grids; see `docs/REPLICATE_UI_PLAYBOOK.md` → "Grid labels → real
  text".
