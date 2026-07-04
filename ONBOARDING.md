# Echo — setup & first run

Echo turns a **running macOS app's UI into clean, verified HTML/CSS**. You point it at any
window (or pick one component), and the `/replicate-ui` skill in Claude Code inspects it via
Accessibility + screenshots, harvests the real fonts/icons/images, generates semantic HTML+CSS,
renders it, and diffs the render against the original until they match.

Two pieces work together:

1. **The Echo app** (`Echo Desktop.app`) — a desktop app that reads the native UI and runs a
   small local **MCP server** on `127.0.0.1:8765` (registered in Claude as **`echo`**). It also
   owns the global hotkeys for picking a component.
2. **The `/replicate-ui` skill** — a **self-contained** Claude Code skill that drives the
   perceive → generate → verify loop. It **bundles its own toolkit** in `_shared/`, so it works
   on any machine **without this repo**.

---

## Quick start (the whole flow in 6 steps)

1. Install `Echo Desktop.app` → `/Applications` (§1) and grant the two permissions (§2).
2. Open Echo once — it self-installs `/replicate-ui` and registers the `echo` + `playwright`
   MCP servers for you (§4).
3. **Restart Claude Code** so it picks up the new MCP servers.
4. Go to any app (Slack, Finder, Blender…), press **⌘⇧S**, and **click** the component you want.
   Echo's status card now shows *"✓ 1 selected from <app>"* with the next step.
5. In Claude Code, run **`/replicate-ui`** — it builds and pixel-verifies the replica, then shows
   it inside Echo's result panel.
6. Outputs land in `.replicate-ui/<app>/` (replica) and `~/Documents/Echo Captures/` (saved
   files; the 💾 buttons also copy the saved file's path to your clipboard).

---

## 1. Install the app

1. **Airdrop** (or copy) `Echo Desktop_0.2.0_aarch64.dmg`, then open it.
2. Drag **Echo Desktop** into `/Applications`.
3. **First launch — read this, macOS will block it.** Echo is self-signed (not notarized), so
   you'll see *“Echo Desktop” Not Opened — Apple could not verify…* with **Done / Move to Bin**:
   - Click **Done** (not "Move to Bin"!), then open **System Settings → Privacy & Security**,
     scroll to the **Security** section → **Open Anyway** → confirm.
   - Or, in Terminal (fastest, removes the quarantine flag):
     ```bash
     xattr -dr com.apple.quarantine "/Applications/Echo Desktop.app"
     ```
   You only do this once; afterwards it opens normally.

## 2. Grant the two permissions (once)

Echo reads other apps' UI and captures their windows, so macOS gates it behind two privacy
permissions. Open **System Settings → Privacy & Security** and toggle **Echo Desktop** on under
**both**:

- **Accessibility** — read the Accessibility (AX) tree: roles, labels, bounds. *(Hotkeys need
  this too.)*
- **Screen Recording** — capture window/region screenshots (without it, shots come back black).

If a list still shows an old row (e.g. "VibeExtract Desktop"), remove it with **–** and re-add
the current app with **+**. Then **Quit & Reopen** Echo.

> Echo is signed with a stable identity, so these grants **survive app updates** — no
> re-granting on every new build.

## 3. MCP server — it's automatic

The MCP server **auto-starts with the app**. The in-app **Status** panel shows it, and a warning
banner appears if it's ever off (with a one-click Start button). To verify by hand:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8765/mcp   # 406 = up (rejects plain GET)
```

To disable autostart for local debugging, launch with `VIBE_MCP_NO_AUTOSTART=1`.

## 4. `/replicate-ui` — the app installs it for you

**No folder copying, no `claude mcp add`.** On launch, Echo automatically:

- installs the **`replicate-ui@echo`** plugin (the `/replicate-ui` + `/replicate-ui-watch`
  skills, staged under `~/.echo/plugin`), and
- registers the two MCP servers in your user config (`~/.claude.json`): **`echo`** (the live app
  URL) + **`playwright`** (the renderer). It **merges** — your existing servers are untouched,
  with a one-time backup at `~/.claude.json.vibe-backup`. Any stale `vibe-extract` entry from
  older builds is cleaned up automatically.

So setup is just: **open the app once → restart Claude Code → run `/replicate-ui`.**

The **"Set up /replicate-ui for Claude Code"** button (under the MCP panel) re-runs/repairs this
anytime and reports anything missing.

**Two prerequisites it can't install for you:**
- **Claude Code** itself, signed in.
- **Node.js** (https://nodejs.org) — used by the `playwright` renderer (`npx`). Python 3 ships
  with macOS; Echo best-effort-installs the one Python lib it needs (Pillow).

> **After you restart the Echo app, reconnect the MCP in Claude:** run `/mcp` → `echo` →
> reconnect (the server restarts with the app, so the old connection goes stale).

---

## 5. Use it

### Pick a component with hotkeys (on the target app, not on Echo)

| Hotkey | Action |
|---|---|
| **⌘⇧S** | Start picking — hover highlights elements |
| **Click** | Select the hovered element (⇧-click to add more) |
| **Enter** | Lock the selection (Echo then tells you the next step) |
| **⌘⇧E** | Extract the selection (quick in-app preview) |
| **⌘⇧X** | Capture the whole frontmost window |
| **↑ / ↓** | Widen / narrow the hovered element |
| **Esc** | Cancel picking |

Echo's **Pick Mode** card always shows where you are in the flow — *Picking → app*,
*"✓ N selected from app — next: run /replicate-ui"*, or *"✓ Captured — preview ready"*.

(If ⌘⇧S is swallowed by a hotkey manager like Bartender/Magnet, pressing **⌘⇧E** with nothing
picked also arms pick mode.)

> **The target app freezes after you click — that's intentional.** Echo suspends the picked
> app (SIGSTOP) so transient UI — hover panels, menus, tooltips — stays open exactly as you
> caught it while you refine the selection with **↑/↓** or press **Enter/⌘⇧E**. The app
> resumes automatically on **Enter** or **Esc** (a new click re-freezes it around the new
> selection); nothing is lost. If Echo ever crashes mid-pick, relaunch it once — it resumes
> any app left frozen on startup.

### Get a high-fidelity replica with Claude (the real deliverable)

1. On the target app: **⌘⇧S**, then **click** the component (or skip selecting to do the whole
   window).
2. In **Claude Code**, run `/replicate-ui`.
   - Selected a component → it replicates **only that component**.
   - No selection → it replicates the **whole window**.
3. It produces verified `index.html` + `assets/` under `.replicate-ui/<app>/`, iterating until
   the render matches the original (≥ 0.92 similarity), then displays it in Echo's result panel.

### The result panel tabs

- **Preview** — the rendered replica (with an optional AX overlay).
- **HTML** — the source. **TOON** — a compact outline of that HTML. **AX Tree** — the
  accessibility tree. **Diagnostics** — what the extractor did.
- The **💾 buttons** save to `~/Documents/Echo Captures/` **and copy the file's path to your
  clipboard** so you can paste it straight into Claude or a terminal.

### Incremental reuse (similar pages get fast)

The **first** page of an app pays full cost (harvest, OCR, verify). **Pages 2..N reuse** cached
fonts/icons/grid labels and start from the previous verified page. To see what's cached:

```bash
python3 ~/.claude/skills/replicate-ui/_shared/cache.py <app>     # e.g. slack
```

---

## Troubleshooting

- **"Not Opened / could not verify" dialog** → self-signed app; see §1 step 3 (Open Anyway or
  the `xattr` command).
- **Screenshots are black / AX tree empty** → the matching permission isn't granted; re-check
  §2, then Quit & Reopen.
- **`/replicate-ui` can't reach `echo`** → the app isn't running, or Claude's connection is
  stale. Make sure the app is open (no red MCP banner), `curl` returns `406`, then `/mcp` →
  reconnect. If your Claude still lists the old `vibe-extract` server, relaunch Echo once (it
  cleans it up) and restart Claude Code.
- **Hotkeys do nothing** → another app may own ⌘⇧S/⌘⇧E; free them, or use the ⌘⇧E auto-arm
  fallback. Echo also needs **Accessibility** for hotkeys.
- **A grid of labels renders as a blurry image** → that's the OCR fallback for baked-in label
  grids; see `docs/REPLICATE_UI_PLAYBOOK.md` → "Grid labels → real text".
