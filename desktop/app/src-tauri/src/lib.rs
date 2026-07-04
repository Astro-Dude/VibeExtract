//! Echo Desktop — Tauri shell.
//!
//! Matches the browser extension's UX exactly:
//!   - Cmd+Shift+S — toggle pick mode (overlay window shows, hover-tracks at 30Hz)
//!   - Click in overlay — add element under click point to selection
//!   - Shift+Click — multi-select
//!   - Escape — exit pick mode
//!   - Cmd+Shift+E — export selection (runs dispatcher per element, merges output)
//!   - Cmd+Shift+X — extract entire frontmost window (no pick mode needed)

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use vibe_extract_core::{
    capture::ScreenPoint,
    dispatcher::{self, ExtractError},
    electron_relaunch,
    picker::PickedElement,
    settings::{self, ElectronRelaunchPref, VibeExtractSettings},
};

/// Embedded MCP server exposing native inspection + screenshots + a visual
/// diff verifier to Claude for automated UI replication.
mod mcp;

/// `contentScript.js` embedded at compile time. Path is relative to *this*
/// source file (src/lib.rs): 4 levels up to repo root.
const CONTENT_SCRIPT: &str = include_str!("../../../../contentScript.js");

/// `assetHarvester.js` embedded at compile time (same repo-root path rule as
/// `CONTENT_SCRIPT`). Driven by the `extract_assets` MCP tool via CDP to pull
/// pixel-perfect real fonts/icons/images out of a running Electron renderer.
const ASSET_HARVESTER: &str = include_str!("../../../../assetHarvester.js");

/// Where capture outputs are written.
struct OutputDir(PathBuf);

/// Hotkey config that the UI may rebind at runtime.
#[derive(Default)]
struct RegisteredHotkeys(Mutex<Vec<Shortcut>>);

/// Selected elements during the current pick session.
#[derive(Default)]
struct PickSession {
    active: bool,
    /// True from the moment we decide to start pick mode until start_pick_mode
    /// either succeeds (`active = true`) or errors out. Prevents a rapid
    /// double-press of ⌘⇧E (or ⌘⇧S) from spawning two concurrent
    /// start_pick_mode flows, which would otherwise double-register Esc/↑/↓
    /// shortcuts, double-install the CGEventTap, and race over `target_pid`.
    starting: bool,
    selected: Vec<PickedElement>,
    // The pid of the first selected element — subsequent shift-clicks must
    // match this pid (same-app constraint per the plan).
    locked_pid: Option<i32>,
    /// PIDs we've already called `wake_app_ax` on, so we don't re-wake every
    /// hover tick. The side-effect persists for the lifetime of the target
    /// process, so once-per-pid-per-session is enough.
    woken_pids: HashSet<i32>,
    /// The frontmost app's pid captured when the user pressed Cmd+Shift+S.
    target_pid: Option<i32>,
    /// The most recent hover element + the screen point we hit-tested at.
    /// On click, we use THIS instead of re-hit-testing — matching how the web
    /// extension's `hoverElement` works. The user sees outline X, clicks, gets X.
    last_hover: Option<PickedElement>,
    /// CDP debug port of the target app when it's Electron — set at pick start.
    /// When present, the hover task drives the highlight from the live DOM
    /// (`cdp::probe_at`) so the user sees the REAL element under the cursor,
    /// instead of the shallow AX result (menu bar / whole window).
    cdp_port: Option<u16>,
    /// The target window's screen bounds, captured at pick start. Used to convert
    /// between screen points and the CDP viewport (viewport = screen − origin).
    target_win: Option<vibe_extract_core::capture::ScreenRect>,
    /// How many extra DOM-parent steps to widen the CDP hover by — ↑ increments,
    /// ↓ decrements. Lets the user grow row → list → sidebar and SEE each step.
    widen_level: u32,
    /// Keyboard tree-navigation (↑ parent / ↓ child), ported from the web
    /// extension's Alt+Arrow flow. `nav_stack` is the path walked UP, popped by ↓
    /// to retrace before falling to the first child (web `wheelNavStack`).
    nav_stack: Vec<PickedElement>,
    /// True while the user is walking the tree via ↑/↓ and HASN'T moved the mouse
    /// — the hover task freezes so it doesn't yank the highlight back to the
    /// cursor (web `isScrollNavigating`). Any real cursor move clears it.
    nav_active: bool,
    /// Cursor position when nav last fired; the hover task ends nav once the
    /// cursor moves away from it.
    nav_anchor_cursor: Option<ScreenPoint>,
    /// Freeze-panel hold (WPS PDF etc.): `Some(pid)` means that app is SUSPENDED
    /// (SIGSTOP) so its hover panel stays frozen open while the cursor roams free.
    /// Set after each pick; resumed (SIGCONT) on Esc / clear / stop, and briefly
    /// around live AX work (overlay_click / walk_hover_ancestry).
    freeze_pid: Option<i32>,
}

#[derive(Default)]
struct PickSessionState(Arc<Mutex<PickSession>>);

/// Owns the live CGEventTap handle. `None` when pick mode is off.
/// Dropping the handle removes the tap, so clicks reach apps normally again.
#[derive(Default)]
struct EventTapState(Mutex<Option<vibe_extract_core::event_tap_macos::TapHandle>>);

/// Holds the data + response channel for an open relaunch-dialog modal.
/// Set when the dialog opens, taken when the user clicks Restart or Cancel.
#[derive(Default)]
struct RelaunchDialogState(Mutex<Option<RelaunchDialogPending>>);

struct RelaunchDialogPending {
    info: RelaunchDialogInfo,
    tx: tokio::sync::oneshot::Sender<RelaunchDialogChoice>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RelaunchDialogInfo {
    bundle_id: String,
    display_name: String,
    known: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RelaunchDialogChoice {
    accept: bool,
    /// "Don't ask again" — meaning depends on the user's accept choice:
    ///   accept=true  + dont_ask=true → save AlwaysYes for this bundle
    ///   accept=false + dont_ask=true → save AlwaysNo for this bundle
    dont_ask: bool,
}

/// Single-flight guard so a rapid double ⌘⇧E doesn't kick off two relaunches.
#[derive(Default)]
struct RelaunchInProgressState(Mutex<bool>);

/// Single-flight guard so rapid ⌘⇧E presses don't spawn multiple concurrent
/// dispatch runs (each one tries CDP which can take up to 15s). The user
/// pressing the key 5x in a row should result in ONE export attempt, not 5.
#[derive(Default)]
struct ExportInProgressState(Mutex<bool>);

/// Tracks the pid of the most recently frontmost app that wasn't us. Updated
/// continuously by a background poller — this is what we use as the "target"
/// when the user presses ⌘⇧S and VibeExtract itself is the current frontmost
/// app (which happens whenever they click on us to read instructions).
#[derive(Default)]
struct LastForeignAppState(Arc<Mutex<Option<i32>>>);

#[derive(Debug, Serialize, Deserialize, Clone)]
struct OverlayBounds {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct OverlayHoverPayload {
    bounds: Option<OverlayBounds>,
    role: String,
    name: String,
    /// Current cursor position so the overlay can draw a custom crosshair.
    /// Updated every tick (~30Hz) — the OS cursor is hidden in CSS.
    cursor: OverlayCursor,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct OverlayCursor {
    x: f64,
    y: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct OverlaySelectedPayload {
    bounds: OverlayBounds,
    role: String,
    name: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ExportPayload {
    strategy: String,
    fidelity: String,
    toon: String,
    html: String,
    screenshot_png_b64: Option<String>,
    diagnostics: Vec<String>,
    /// Serialized AX tree (the semantic spec); `None` for non-AX strategies.
    ax_tree: Option<String>,
    picked_summary: String,
    count: usize,
}

fn dirs_home() -> PathBuf {
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn find_output_dir() -> PathBuf {
    let dir = dirs_home().join("Documents").join("Echo Captures");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Frontend: the captures output folder as a display string (so the UI never
/// hardcodes the path).
#[tauri::command]
fn output_dir_info() -> String {
    find_output_dir().display().to_string()
}

/// Frontend: reveal the captures folder in Finder.
#[tauri::command]
fn reveal_output_dir() -> Result<(), String> {
    let dir = find_output_dir();
    std::process::Command::new("open")
        .arg(&dir)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ============================================================================
// Claude Code integration — the app SELF-INSTALLS the /replicate-ui skill and
// registers its MCP servers on launch, so distributing the .app is all anyone
// needs (no manual ~/.claude/skills copying, no `claude mcp add`).
// ============================================================================

#[derive(serde::Serialize, Clone, Debug)]
pub struct SetupReport {
    pub skill_installed: bool,
    pub skill_path: String,
    pub mcp_registered: bool,
    pub vibe_url: String,
    pub pillow_ok: bool,
    pub node_ok: bool,
    pub notes: Vec<String>,
}

/// Recursively copy a dir, skipping python/OS cruft.
fn copy_tree(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        let n = name.to_string_lossy();
        if n == "__pycache__" || n.ends_with(".pyc") || n == ".DS_Store" {
            continue;
        }
        let to = dst.join(&name);
        if entry.path().is_dir() {
            copy_tree(&entry.path(), &to)?;
        } else {
            std::fs::copy(entry.path(), &to)?;
        }
    }
    Ok(())
}

/// Locate a bundled skill folder (`<name>/SKILL.md`): the .app's Resources first
/// (shipped build), then this repo's skills dir (dev build, path baked at compile time).
fn bundled_skill(app: &AppHandle, name: &str) -> Option<PathBuf> {
    let mut cands: Vec<PathBuf> = Vec::new();
    if let Ok(rd) = app.path().resource_dir() {
        cands.push(rd.join("resources").join(name));
        cands.push(rd.join(name));
    }
    cands.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../.claude/skills")
            .join(name),
    );
    cands.into_iter().find(|p| p.join("SKILL.md").exists())
}

/// Locate the bundled plugin *marketplace* dir (holds `.claude-plugin/marketplace.json`):
/// the .app's Resources first (shipped build), then this repo's resources (dev build).
fn bundled_plugin(app: &AppHandle) -> Option<PathBuf> {
    let mut cands: Vec<PathBuf> = Vec::new();
    if let Ok(rd) = app.path().resource_dir() {
        cands.push(rd.join("resources").join("plugin"));
        cands.push(rd.join("plugin"));
    }
    cands.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources").join("plugin"));
    cands
        .into_iter()
        .find(|p| p.join(".claude-plugin").join("marketplace.json").exists())
}

/// Run a command through a login shell, returning (success, combined stdout+stderr).
fn login_shell_status(cmd: &str) -> (bool, String) {
    match std::process::Command::new("/bin/zsh").args(["-lc", cmd]).output() {
        Ok(o) => {
            let mut s = String::from_utf8_lossy(&o.stdout).into_owned();
            s.push_str(&String::from_utf8_lossy(&o.stderr));
            (o.status.success(), s)
        }
        Err(e) => (false, e.to_string()),
    }
}

/// True if the `claude` CLI is on the (login-shell) PATH.
fn has_claude_cli() -> bool {
    !login_shell("command -v claude").is_empty()
}

/// Install the bundled plugin via the `claude` CLI (writes Claude's own config correctly —
/// no fabricating ~/.claude internals). Copies the bundled marketplace to a stable WRITABLE
/// location, bakes the live MCP url into the plugin manifest, then `marketplace add` + `install`
/// (both idempotent, falling back to `update`). Returns Ok(true) if the plugin ends up installed.
fn install_plugin_via_cli(app: &AppHandle, vibe_url: &str, notes: &mut Vec<String>) -> Result<bool, String> {
    let src = bundled_plugin(app).ok_or("bundled plugin marketplace not found")?;
    // Stable writable copy (the .app Resources is read-only; the marketplace source path must persist).
    let dest = dirs_home().join(".echo").join("plugin");
    let _ = std::fs::remove_dir_all(&dest);
    copy_tree(&src, &dest).map_err(|e| format!("copy plugin failed: {e}"))?;

    // Bake the live echo MCP url into the installed plugin manifest (the MCP port can vary).
    let manifest = dest.join("replicate-ui").join(".claude-plugin").join("plugin.json");
    if let Ok(txt) = std::fs::read_to_string(&manifest) {
        if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&txt) {
            if let Some(srv) = v.pointer_mut("/mcpServers/echo/url") {
                *srv = serde_json::Value::String(vibe_url.to_string());
            }
            if let Ok(body) = serde_json::to_string_pretty(&v) {
                let _ = std::fs::write(&manifest, body);
            }
        }
    }

    let dest_s = dest.display().to_string();
    // Idempotent: best-effort remove the pre-rename registrations (vibe-extract era),
    // then add (or refresh) the marketplace and install (or update) the plugin.
    let cmd = format!(
        "claude plugin uninstall replicate-ui@vibe-extract >/dev/null 2>&1; \
         claude plugin marketplace remove vibe-extract >/dev/null 2>&1; \
         claude mcp remove vibe-extract >/dev/null 2>&1; \
         claude plugin marketplace add '{p}' --scope user 2>&1 || claude plugin marketplace update echo 2>&1; \
         claude plugin install replicate-ui@echo --scope user 2>&1 || claude plugin update replicate-ui@echo 2>&1; \
         claude plugin list 2>&1",
        p = dest_s.replace('\'', "'\\''")
    );
    let (_ok, out) = login_shell_status(&cmd);
    let installed = out.contains("replicate-ui@echo");
    if installed {
        notes.push("installed /replicate-ui plugin (echo MCP bundled, on by default)".into());
    } else {
        notes.push(format!("plugin install did not confirm; CLI said: {}", out.trim().chars().take(200).collect::<String>()));
    }
    Ok(installed)
}

fn has_pillow() -> bool {
    String::from_utf8_lossy(&login_shell("python3 -c 'import PIL' 2>/dev/null && echo OK")).contains("OK")
}

/// Run a command through a login shell so it sees the user's full PATH (a
/// Finder-launched .app otherwise inherits only /usr/bin:/bin). Returns stdout bytes.
fn login_shell(cmd: &str) -> Vec<u8> {
    std::process::Command::new("/bin/zsh")
        .args(["-lc", cmd])
        .output()
        .map(|o| o.stdout)
        .unwrap_or_default()
}

/// Merge our MCP servers into ~/.claude.json (user scope) WITHOUT clobbering the
/// user's other config/servers. echo -> the live url; playwright added only
/// if absent. Order-preserving + atomic + one-time backup. Returns true if changed.
fn register_mcp_servers(vibe_url: &str) -> Result<bool, String> {
    use serde_json::{json, Value};
    let path = dirs_home().join(".claude.json");
    let mut root: Value = if path.exists() {
        let txt = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        match serde_json::from_str(&txt) {
            Ok(v) => v,
            Err(e) => return Err(format!("~/.claude.json isn't valid JSON ({e}) — left untouched")),
        }
    } else {
        json!({})
    };
    if !root.is_object() {
        return Err("~/.claude.json isn't a JSON object — left untouched".into());
    }
    let before = serde_json::to_string(&root).unwrap_or_default();
    {
        let obj = root.as_object_mut().unwrap();
        let servers = obj.entry("mcpServers").or_insert_with(|| json!({}));
        if !servers.is_object() {
            *servers = json!({});
        }
        let s = servers.as_object_mut().unwrap();
        // Rebrand: the server registers as `echo` now; drop any stale pre-rename entry.
        s.remove("vibe-extract");
        s.insert("echo".to_string(), json!({"type": "http", "url": vibe_url}));
        s.entry("playwright").or_insert_with(|| {
            json!({"command": "npx", "args": ["@playwright/mcp@latest", "--headless", "--isolated"]})
        });
    }
    if serde_json::to_string(&root).unwrap_or_default() == before {
        return Ok(false);
    }
    let bak = dirs_home().join(".claude.json.vibe-backup");
    if path.exists() && !bak.exists() {
        let _ = std::fs::copy(&path, &bak);
    }
    let body = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    let tmp = dirs_home().join(".claude.json.vibe-tmp");
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Install the bundled PLUGIN (skills + echo MCP) + best-effort deps. Idempotent.
/// Primary path: `claude plugin marketplace add` + `install` so one app install gives the user
/// `/replicate-ui` and the echo MCP with no manual setup. Fallback (no `claude` CLI):
/// the legacy loose-skill copy into ~/.claude/skills + MCP merge into ~/.claude.json.
fn setup_claude_integration(app: &AppHandle, mcp_url: Option<String>) -> Result<SetupReport, String> {
    let mut notes: Vec<String> = Vec::new();
    let vibe_url = mcp_url.unwrap_or_else(|| "http://127.0.0.1:8765/mcp".to_string());

    let mut skill_installed = false;
    let mut skill_path = String::new();
    let mut mcp_registered = false;

    // 1) PRIMARY: install as a Claude Code plugin (skills + MCP, both via the plugin).
    let plugin_ok = if has_claude_cli() {
        match install_plugin_via_cli(app, &vibe_url, &mut notes) {
            Ok(true) => {
                skill_installed = true;
                mcp_registered = true; // the plugin bundles + auto-registers the echo MCP
                skill_path =
                    dirs_home().join(".echo").join("plugin").join("replicate-ui").display().to_string();
                // Remove the legacy loose skills so /replicate-ui isn't defined twice.
                let sk = dirs_home().join(".claude").join("skills");
                for n in ["replicate-ui", "replicate-ui-watch"] {
                    let _ = std::fs::remove_dir_all(sk.join(n));
                }
                true
            }
            Ok(false) => false,
            Err(e) => {
                notes.push(format!("plugin install: {e}"));
                false
            }
        }
    } else {
        notes.push("`claude` CLI not on PATH — used loose-skill fallback (install Claude Code for the plugin)".into());
        false
    };

    // 2) FALLBACK: legacy loose-skill copy + MCP merge (only if the plugin path failed).
    if !plugin_ok {
        let skills_dir = dirs_home().join(".claude").join("skills");
        std::fs::create_dir_all(&skills_dir).map_err(|e| e.to_string())?;
        for name in ["replicate-ui", "replicate-ui-watch"] {
            if let Some(src) = bundled_skill(app, name) {
                let dst = skills_dir.join(name);
                let _ = std::fs::remove_dir_all(&dst);
                match copy_tree(&src, &dst) {
                    Ok(_) => {
                        if name == "replicate-ui" {
                            skill_installed = true;
                            skill_path = dst.display().to_string();
                        }
                    }
                    Err(e) => notes.push(format!("copy {name} failed: {e}")),
                }
            } else if name == "replicate-ui" {
                notes.push("bundled replicate-ui skill not found".into());
            }
        }
        mcp_registered = match register_mcp_servers(&vibe_url) {
            Ok(changed) => {
                if changed {
                    notes.push("registered MCP servers in ~/.claude.json".into());
                }
                true
            }
            Err(e) => {
                notes.push(format!("MCP registration: {e}"));
                false
            }
        };
    }

    // 3) best-effort deps (don't block; just report what's missing)
    let mut pillow_ok = has_pillow();
    if !pillow_ok {
        let _ = login_shell("python3 -m pip install --user --quiet Pillow");
        pillow_ok = has_pillow();
    }
    if !pillow_ok {
        notes.push("Pillow missing — run: python3 -m pip install --user Pillow".into());
    }
    let node_ok = !login_shell("command -v node").is_empty();
    if !node_ok {
        notes.push("Node.js not found — install from https://nodejs.org (for the Playwright renderer)".into());
    }

    Ok(SetupReport {
        skill_installed,
        skill_path,
        mcp_registered,
        vibe_url,
        pillow_ok,
        node_ok,
        notes,
    })
}

/// UI/manual trigger: re-run the self-install (repair).
#[tauri::command]
async fn install_replicate_ui_skill(app: AppHandle) -> Result<SetupReport, String> {
    let url = app.state::<mcp::McpServerState>().snapshot().url;
    setup_claude_integration(&app, url)
}

/// Make the overlay window appear over full-screen apps (e.g. Slack
/// full-screen, browsers in full-screen mode).
///
/// macOS by default places each full-screen app in its own Space, and floating
/// windows don't follow into those Spaces. To override:
///  1. Add `NSWindowCollectionBehaviorCanJoinAllSpaces` so the window appears
///     on every Space.
///  2. Add `NSWindowCollectionBehaviorFullScreenAuxiliary` so it can appear
///     over a full-screen app's own Space.
///  3. Raise the window level to `NSScreenSaverWindowLevel` (1000) — above the
///     menu bar (24) and status items (25), guarantees we paint over anything.
///
/// Done via raw Objective-C FFI on the NSWindow* that Tauri exposes via
/// `ns_window()`.
#[cfg(target_os = "macos")]
fn make_overlay_fullscreen_compatible(window: &tauri::WebviewWindow) {
    use std::ffi::c_char;
    use std::ffi::c_void;

    // NSWindowCollectionBehavior bits
    const CAN_JOIN_ALL_SPACES: u64 = 1 << 0;
    const TRANSIENT: u64 = 1 << 3;
    const FULL_SCREEN_AUXILIARY: u64 = 1 << 8;
    // NSScreenSaverWindowLevel — well above full-screen apps.
    const NS_SCREEN_SAVER_LEVEL: i64 = 1000;

    let ns_window: *mut c_void = match window.ns_window() {
        Ok(p) => p as *mut c_void,
        Err(e) => {
            log::warn!("ns_window() failed: {}", e);
            return;
        }
    };

    #[link(name = "objc")]
    extern "C" {
        fn sel_registerName(name: *const c_char) -> *const c_void;
        fn objc_msgSend();
    }

    type MsgGetU64 = unsafe extern "C" fn(obj: *mut c_void, sel: *const c_void) -> u64;
    type MsgSetU64 = unsafe extern "C" fn(obj: *mut c_void, sel: *const c_void, arg: u64);
    type MsgSetI64 = unsafe extern "C" fn(obj: *mut c_void, sel: *const c_void, arg: i64);

    unsafe {
        let sel_get_behavior =
            sel_registerName(b"collectionBehavior\0".as_ptr() as *const c_char);
        let sel_set_behavior =
            sel_registerName(b"setCollectionBehavior:\0".as_ptr() as *const c_char);
        let sel_set_level = sel_registerName(b"setLevel:\0".as_ptr() as *const c_char);

        let get: MsgGetU64 = std::mem::transmute(objc_msgSend as *const ());
        let set_u64: MsgSetU64 = std::mem::transmute(objc_msgSend as *const ());
        let set_i64: MsgSetI64 = std::mem::transmute(objc_msgSend as *const ());

        let current = get(ns_window, sel_get_behavior);
        let new_behavior =
            current | CAN_JOIN_ALL_SPACES | FULL_SCREEN_AUXILIARY | TRANSIENT;
        set_u64(ns_window, sel_set_behavior, new_behavior);
        set_i64(ns_window, sel_set_level, NS_SCREEN_SAVER_LEVEL);

        log::info!(
            "overlay full-screen compat: behavior {} -> {}, level=NSScreenSaverWindowLevel({})",
            current, new_behavior, NS_SCREEN_SAVER_LEVEL
        );
    }
}

/// Returns the pid of the currently frontmost (foreground) application
/// according to macOS's launch services. More reliable than AXFocusedApplication
/// when our own webview has stolen partial focus.
///
/// Implementation: shells out to `lsappinfo front` (returns the ASN of the
/// frontmost app) then `lsappinfo info -only pid <asn>`. ~10ms cold.
#[cfg(target_os = "macos")]
fn frontmost_app_pid_via_nsworkspace() -> Option<i32> {
    let front = std::process::Command::new("/usr/bin/lsappinfo")
        .arg("front")
        .output()
        .ok()?;
    let asn = String::from_utf8_lossy(&front.stdout).trim().to_string();
    if asn.is_empty() {
        return None;
    }
    let info = std::process::Command::new("/usr/bin/lsappinfo")
        .args(["info", "-only", "pid", &asn])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&info.stdout);
    // Output looks like:  "pid"=12345
    for line in text.lines() {
        if let Some(eq) = line.find('=') {
            let val = line[eq + 1..].trim();
            if let Ok(pid) = val.parse::<i32>() {
                return Some(pid);
            }
        }
    }
    None
}

/// Get a human-readable app name for a pid via `lsappinfo info`.
#[cfg(target_os = "macos")]
fn app_name_for_pid(pid: i32) -> Option<String> {
    let out = std::process::Command::new("/usr/bin/lsappinfo")
        .args(["info", "-only", "name", "-app", &pid.to_string()])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        if let Some(eq) = line.find('=') {
            let val = line[eq + 1..].trim().trim_matches('"');
            if !val.is_empty() {
                return Some(val.to_string());
            }
        }
    }
    None
}

#[cfg(not(target_os = "macos"))]
fn app_name_for_pid(_pid: i32) -> Option<String> { None }

/// Force the main window to the user's current Space + bring it forward.
///
/// On macOS, the standard way to make an app appear on the user's *current*
/// Space (especially over a full-screen app) is `[NSApp
/// activateIgnoringOtherApps:YES]`. Tauri's `set_focus` alone doesn't cross
/// Space boundaries — the activate call does. We also briefly toggle
/// always-on-top so we paint on top, then release it.
fn raise_main_window(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    activate_app_ignoring_others();

    if let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
        let _ = main.set_always_on_top(true);
        let app_clone = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(400)).await;
            if let Some(main) = app_clone.get_webview_window("main") {
                let _ = main.set_always_on_top(false);
            }
        });
    }
}

/// Equivalent of `[[NSApplication sharedApplication] activateIgnoringOtherApps:YES]`
/// via raw Objective-C FFI. Doesn't depend on Tauri's `ns_window()` (which is
/// unstable across show/hide on transparent windows) — instead asks NSApp
/// itself to come forward across Spaces.
#[cfg(target_os = "macos")]
fn activate_app_ignoring_others() {
    use std::ffi::c_char;
    use std::ffi::c_void;
    #[link(name = "objc")]
    extern "C" {
        fn objc_getClass(name: *const c_char) -> *const c_void;
        fn sel_registerName(name: *const c_char) -> *const c_void;
        fn objc_msgSend();
    }
    type Msg0 = unsafe extern "C" fn(obj: *const c_void, sel: *const c_void) -> *const c_void;
    type Msg1Bool = unsafe extern "C" fn(obj: *const c_void, sel: *const c_void, arg: bool);
    unsafe {
        let cls = objc_getClass(b"NSApplication\0".as_ptr() as *const c_char);
        if cls.is_null() {
            return;
        }
        let sel_shared = sel_registerName(b"sharedApplication\0".as_ptr() as *const c_char);
        let sel_activate =
            sel_registerName(b"activateIgnoringOtherApps:\0".as_ptr() as *const c_char);
        let get_shared: Msg0 = std::mem::transmute(objc_msgSend as *const ());
        let activate: Msg1Bool = std::mem::transmute(objc_msgSend as *const ());
        let app: *const c_void = get_shared(cls, sel_shared);
        if !app.is_null() {
            activate(app, sel_activate, true);
        }
    }
}

fn to_overlay_bounds(p: &vibe_extract_core::capture::ScreenRect) -> OverlayBounds {
    OverlayBounds {
        x: p.x,
        y: p.y,
        w: p.w,
        h: p.h,
    }
}

// =============================================================================
// Tauri commands
// =============================================================================

#[tauri::command]
async fn check_ax_permission() -> bool {
    #[cfg(target_os = "macos")]
    {
        vibe_extract_core::ax_macos::check_permission(false)
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

#[tauri::command]
async fn request_ax_permission() {
    #[cfg(target_os = "macos")]
    {
        vibe_extract_core::ax_macos::check_permission(true);
        vibe_extract_core::ax_macos::open_accessibility_settings();
    }
}

/// The largest on-screen window owned by `pid` — its screen bounds become the
/// CDP-viewport origin for the live hover probe.
#[cfg(target_os = "macos")]
fn largest_window_bounds_for_pid(pid: i32) -> Option<vibe_extract_core::capture::ScreenRect> {
    vibe_extract_core::windows_list::list_windows()
        .into_iter()
        .filter(|w| w.pid == pid && w.bounds.w >= 1.0 && w.bounds.h >= 1.0)
        .max_by(|a, b| {
            (a.bounds.w * a.bounds.h)
                .partial_cmp(&(b.bounds.w * b.bounds.h))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|w| w.bounds)
}

#[tauri::command]
async fn start_pick_mode(app: AppHandle) -> Result<(), String> {
    log::info!("start_pick_mode");

    // Determine target. Priority order:
    //   1. Current frontmost (if not us) — user is in target right now
    //   2. The last-seen non-VibeExtract frontmost (tracked by background poller)
    //      — used when user clicked on VibeExtract to read instructions
    //      then pressed ⌘⇧S
    #[cfg(target_os = "macos")]
    let target_pid = {
        let our_pid = std::process::id() as i32;
        let ax = vibe_extract_core::ax_macos::frontmost_app_pid();
        let ns = frontmost_app_pid_via_nsworkspace();
        let current_other = ns.filter(|p| *p != our_pid)
            .or_else(|| ax.filter(|p| *p != our_pid));
        let last_other = app
            .try_state::<LastForeignAppState>()
            .and_then(|s| s.0.lock().unwrap().clone());
        log::info!(
            "start_pick_mode: AXFocused={:?}, lsappinfo={:?}, last_other={:?}",
            ax, ns, last_other
        );
        current_other.or(last_other)
    };
    #[cfg(not(target_os = "macos"))]
    let target_pid: Option<i32> = None;

    // Resolve target name for user feedback.
    let target_name = target_pid.and_then(|pid| app_name_for_pid(pid));
    log::info!(
        "start_pick_mode: chosen target = {:?} (name: {:?})",
        target_pid, target_name
    );

    // No resolvable target yet (e.g. VibeExtract itself is frontmost when ⌘⇧S fires).
    // DON'T fail — arming anyway is the correct UX: the overlay HUD guides the user, the
    // hover task falls back to system-wide hit-testing, and the first click resolves +
    // locks the clicked app's pid. (Previously this returned Err before emitting
    // `pick-mode-changed`, so the UI never toggled — the "Start does nothing" bug.)
    if target_pid.is_none() {
        let _ = app.emit(
            "toast",
            "Pick mode on — hover the app you want and click. ⌘⇧E to extract · Esc to cancel.".to_string(),
        );
    }

    // Wake the target NOW (before showing overlay), then sleep so Electron has
    // time to build its AX tree before the first hover hit.
    #[cfg(target_os = "macos")]
    if let Some(pid) = target_pid {
        vibe_extract_core::ax_macos::wake_app_ax(pid);
    }
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    // For an Electron target the real UI isn't in the AX tree — so drive the
    // hover highlight from the live DOM via CDP. Detect framework + debug port +
    // the window origin now; the hover task uses them to probe + convert coords.
    #[cfg(target_os = "macos")]
    let (cdp_port, target_win): (Option<u16>, Option<vibe_extract_core::capture::ScreenRect>) =
        if let Some(pid) = target_pid {
            let app_path = vibe_extract_core::ax_macos::pid_to_path(pid);
            let is_electron = app_path
                .as_deref()
                .map(|p| {
                    matches!(
                        vibe_extract_core::framework_detect::detect(std::path::Path::new(p)),
                        vibe_extract_core::framework_detect::Framework::Electron
                    )
                })
                .unwrap_or(false);
            if is_electron {
                let port = vibe_extract_core::cdp::discover_port().await;
                if port.is_none() {
                    let _ = app.emit(
                        "toast",
                        "This Electron app isn't in debug mode — the selection highlight will be approximate. Accept the restart prompt (or press ⌘⇧E) for pixel-accurate picking.".to_string(),
                    );
                }
                (port, largest_window_bounds_for_pid(pid))
            } else {
                (None, None)
            }
        } else {
            (None, None)
        };
    #[cfg(not(target_os = "macos"))]
    let (cdp_port, target_win): (Option<u16>, Option<vibe_extract_core::capture::ScreenRect>) =
        (None, None);

    // Reset session state. CRITICAL: clear `last_hover` too — a stale
    // PickedElement from a prior session (often VibeExtract's own AXMenuBar
    // due to Apple's global hit-test behavior, see ax_macos.rs notes) will
    // otherwise be returned by the first overlay_click of the new session.
    {
        let state = app.state::<PickSessionState>();
        let mut s = state.0.lock().unwrap();
        s.active = true;
        s.selected.clear();
        // Lock the whole session to the target app up front (Problem 2). If VibeExtract
        // itself was frontmost, target_pid is None → the first pick lazy-locks it.
        s.locked_pid = target_pid;
        s.woken_pids.clear();
        s.target_pid = target_pid;
        s.last_hover = None;
        s.cdp_port = cdp_port;
        s.target_win = target_win;
        s.widen_level = 0;
        s.nav_stack.clear();
        s.nav_active = false;
        s.nav_anchor_cursor = None;
        unfreeze_app(&mut s.freeze_pid); // resume any frozen app (SIGCONT)
    }

    // Show the overlay window, size it to the primary monitor.
    // Order matters: position + size BEFORE show, then show, then
    // ignore_cursor_events(false) (must be after show per Tauri docs).
    if let Some(overlay) = app.get_webview_window("overlay") {
        if let Some(monitor) = overlay.primary_monitor().ok().flatten() {
            let size = monitor.size();
            let pos = monitor.position();
            let scale = monitor.scale_factor();
            let _ = overlay.set_position(tauri::PhysicalPosition { x: pos.x, y: pos.y });
            let _ = overlay.set_size(tauri::PhysicalSize {
                width: size.width,
                height: size.height,
            });
            log::info!(
                "overlay sized to {}x{} @ ({}, {}), scale={}",
                size.width,
                size.height,
                pos.x,
                pos.y,
                scale
            );
        }
        let _ = overlay.show();
        let _ = overlay.set_always_on_top(true);
    }
    // Give the compositor a tick to commit the show. Overlay stays click-through —
    // CGEventTap handles clicks instead.
    tokio::time::sleep(std::time::Duration::from_millis(60)).await;
    if let Some(overlay) = app.get_webview_window("overlay") {
        // Overlay is ALWAYS click-through. Mouse events go to CGEventTap.
        let _ = overlay.set_ignore_cursor_events(true);
        // NOTE: full-screen compatibility (collectionBehavior + window level)
        // is set ONCE at startup via make_overlay_fullscreen_compatible. Calling
        // it again here after the window has been shown causes Tauri's
        // ns_window() pointer to be unstable on macOS and crashes the process.
        // Tauri's set_visible_on_all_workspaces alone is safe to call here.
        let _ = overlay.set_visible_on_all_workspaces(true);
        let _ = overlay.emit("overlay-selections", Vec::<OverlaySelectedPayload>::new());
        log::info!("overlay shown (click-through); is_visible={:?}", overlay.is_visible());
    }

    // Install the CGEventTap. The callback fires on every left-mouse-down
    // system-wide while pick mode is on. Captures clicks even though our
    // overlay window is click-through.
    #[cfg(target_os = "macos")]
    {
        let app_for_tap = app.clone();
        let tap_result = vibe_extract_core::event_tap_macos::install_mouse_down_tap(
            move |x: f64, y: f64, shift: bool| {
                // macOS dispatches synthetic mouseDown events at exact (0,0)
                // during system focus changes and app relaunches. Filter these
                // — they don't correspond to any real user click and would
                // otherwise pollute the selection state.
                if x.abs() < 1.0 && y.abs() < 1.0 {
                    log::debug!("event_tap: ignoring synthetic (0,0) click");
                    return;
                }
                log::info!("event_tap: mouseDown at ({:.0},{:.0}) shift={}", x, y, shift);
                // Spawn a tokio task that runs the same logic as overlay_click.
                let app_inner = app_for_tap.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = overlay_click(app_inner, x, y, shift).await {
                        log::warn!("event_tap click handler failed: {}", e);
                    }
                });
            },
        );
        match tap_result {
            Ok(handle) => {
                *app.state::<EventTapState>().0.lock().unwrap() = Some(handle);
                log::info!("event_tap: state stored, clicks will be captured");
            }
            Err(e) => {
                log::error!("event_tap install failed: {}", e);
                let _ = app.emit("toast", format!("Click capture failed: {}", e));
            }
        }
    }

    // Tell the main window to update its status + share the target name.
    let _ = app.emit("pick-mode-changed", true);
    let _ = app.emit(
        "target-app",
        target_name.clone().unwrap_or_else(|| format!("pid {}", target_pid.unwrap_or(-1))),
    );

    // Spawn the hover-tracking task.
    spawn_hover_task(app.clone());

    // Register Esc, Enter and ↑/↓ as temporary global shortcuts. Esc cancels pick
    // mode; Enter LOCKS the selection (resume the frozen app + exit, see
    // `commit_selection`); ↑/↓ walk the AX ancestry of the currently hovered element
    // so the user can select a larger / smaller region than Apple's AX hit-test
    // returns by default. Unregistered in stop_pick_mode so we don't steal these keys
    // from other apps while VibeExtract isn't actively picking.
    let pick_keys = [
        (Shortcut::new(None, Code::Escape), "Esc"),
        (Shortcut::new(None, Code::Enter), "Enter"),
        (Shortcut::new(None, Code::ArrowUp), "ArrowUp"),
        (Shortcut::new(None, Code::ArrowDown), "ArrowDown"),
    ];
    for (s, name) in pick_keys.iter() {
        match app.global_shortcut().register(s.clone()) {
            Ok(_) => log::info!("registered {} shortcut (pick-mode-scoped)", name),
            Err(e) => log::warn!("failed to register {} shortcut: {}", name, e),
        }
    }

    Ok(())
}

#[tauri::command]
async fn stop_pick_mode(app: AppHandle) -> Result<(), String> {
    log::info!("stop_pick_mode");
    {
        let state = app.state::<PickSessionState>();
        let mut s = state.0.lock().unwrap();
        s.active = false;
        s.selected.clear();
        s.locked_pid = None;
        unfreeze_app(&mut s.freeze_pid); // resume any frozen app — Esc must never leave it suspended
    }
    teardown_pick_mode_ui(&app);
    Ok(())
}

/// Tear down the pick-mode UI WITHOUT touching the selection/lock state: drop the
/// event tap (restores normal clicks), hide the overlay, unregister the pick-mode
/// shortcuts, and tell the UI pick mode ended. Shared by `stop_pick_mode` (cancel,
/// which also clears the selection) and `commit_selection` (which KEEPS it).
fn teardown_pick_mode_ui(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let tap_state = app.state::<EventTapState>();
        let mut guard = tap_state.0.lock().unwrap();
        if guard.is_some() {
            drop(guard.take()); // explicit Drop call
            log::info!("event_tap: dropped on pick-mode teardown");
        }
    }
    if let Some(overlay) = app.get_webview_window("overlay") {
        let _ = overlay.emit("overlay-hide", ());
        let _ = overlay.hide();
        let _ = overlay.set_ignore_cursor_events(true);
    }
    // Unregister the pick-mode-scoped shortcuts. Use `unregister` per key
    // so we don't kill the ⌘⇧S/E/X bindings via unregister_all.
    let pick_keys = [
        (Shortcut::new(None, Code::Escape), "Esc"),
        (Shortcut::new(None, Code::Enter), "Enter"),
        (Shortcut::new(None, Code::ArrowUp), "ArrowUp"),
        (Shortcut::new(None, Code::ArrowDown), "ArrowDown"),
    ];
    for (s, name) in pick_keys.iter() {
        match app.global_shortcut().unregister(s.clone()) {
            Ok(_) => log::debug!("unregistered {} shortcut", name),
            Err(e) => log::debug!("unregister {}: {} (likely never registered)", name, e),
        }
    }
    let _ = app.emit("pick-mode-changed", false);
}

/// Enter during pick mode: LOCK the current selection and RESUME the frozen target,
/// then exit pick mode and bring VibeExtract forward with the captured result. The
/// selection (with its pick-time crop + AX subtree) is KEPT and persisted, so
/// extraction works even after the original app is closed/switched. If nothing has
/// been picked yet, stays armed and nudges the user.
#[tauri::command]
async fn commit_selection(app: AppHandle) -> Result<(), String> {
    log::info!("commit_selection");
    let list = {
        let state = app.state::<PickSessionState>();
        let mut s = state.0.lock().unwrap();
        if s.selected.is_empty() {
            None
        } else {
            s.active = false;
            unfreeze_app(&mut s.freeze_pid); // resume the target — the pick is fully captured
            Some(s.selected.clone())
        }
    };
    let Some(list) = list else {
        let _ = app.emit("toast", "Click an element first, then press Enter to lock it.");
        return Ok(());
    };
    persist_and_broadcast(&app, &list); // ensure last-selection.json reflects the final pick
    teardown_pick_mode_ui(&app);
    // Slim per-element payload (not just a count) — the UI shows the locked
    // components (name/role/size + pick-time crop thumbnail) so the user sees
    // WHAT locked. ax_tree is deliberately omitted (can be hundreds of KB).
    let slim: Vec<serde_json::Value> = list
        .iter()
        .map(|p| {
            serde_json::json!({
                "role": p.role,
                "name": p.name,
                "bounds": p.bounds,
                "crop_path": p.crop_path,
            })
        })
        .collect();
    let _ = app.emit("selection-committed", slim);
    raise_main_window(&app);
    Ok(())
}

/// Monotonic counter for pick-time crop filenames (`pick-crop-<pid>-<seq>.png`).
/// The unique seq also serves as a per-pick identity for the auto-trigger watcher.
static PICK_CROP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Process-global mirror of the session's frozen pid (`0` = none). Written ONLY via
/// `record_freeze`/`clear_freeze_record` (called by `freeze_app`/`unfreeze_app`). It is
/// lock-free so the panic hook and the `RunEvent::Exit` handler can SIGCONT a frozen
/// target WITHOUT touching the (possibly poisoned/held) `PickSession` mutex.
static FROZEN_PID: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);

/// Path to a tiny file holding the currently-frozen pid, so that if VibeExtract is
/// `SIGKILL`ed (no in-process handler can run) the NEXT launch can SIGCONT the orphan.
/// Set once at setup; helpers no-op until then.
static FROZEN_PID_FILE: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

/// Banner shown on the overlay while the target is SIGSTOP-frozen for ↑/↓ refinement,
/// so the pause reads as intentional (Problem 1) rather than a crash.
const REFINE_BANNER: &str =
    "Target paused for refine — ↑/↓ resize · Enter to lock · Esc to cancel";

/// Record a freeze in the lock-free atomic + the on-disk recovery file. Best-effort.
fn record_freeze(pid: i32) {
    FROZEN_PID.store(pid, std::sync::atomic::Ordering::SeqCst);
    if let Some(p) = FROZEN_PID_FILE.get() {
        let _ = std::fs::write(p, pid.to_string());
    }
}

/// Clear the freeze record (atomic + file). Best-effort.
fn clear_freeze_record() {
    FROZEN_PID.store(0, std::sync::atomic::Ordering::SeqCst);
    if let Some(p) = FROZEN_PID_FILE.get() {
        let _ = std::fs::remove_file(p);
    }
}

/// At startup, SIGCONT any pid left frozen by a previous VibeExtract that was killed
/// before it could resume the target (the `SIGKILL` case). Best-effort; clears the file.
fn resume_orphaned_freeze_on_launch() {
    let Some(path) = FROZEN_PID_FILE.get() else { return };
    if let Ok(s) = std::fs::read_to_string(path) {
        if let Ok(pid) = s.trim().parse::<i32>() {
            if pid > 0 {
                log::warn!("resume_orphaned_freeze_on_launch: SIGCONT orphaned pid {}", pid);
                #[cfg(target_os = "macos")]
                vibe_extract_core::app_freeze_macos::resume(pid);
            }
        }
        let _ = std::fs::remove_file(path);
    }
}

/// Capture the picked element's pixels NOW (occlusion-immune via `screencapture -l`
/// on the owning window, cropped to the element bounds) → sets `picked.crop_path`.
/// Best-effort; shallow picks are skipped (their bounds are a click placeholder).
/// Shared by the mouse click (`overlay_click`) and keyboard tree-nav (`walk_hover_ancestry`).
async fn capture_pick_crop(app: &AppHandle, picked: &mut PickedElement) {
    if picked.ax_shallow {
        return;
    }
    let elem = picked.bounds;
    let pid = picked.pid;
    // Owning window: a normal-layer window containing the element, else any-layer
    // containing it (menus/popovers live on layer>0), else first window for the pid.
    let target_win = {
        let wins = vibe_extract_core::windows_list::list_windows();
        let center = elem.center();
        wins.iter()
            .filter(|w| w.pid == pid && w.layer == 0)
            .find(|w| w.bounds.contains(center))
            .or_else(|| wins.iter().filter(|w| w.pid == pid).find(|w| w.bounds.contains(center)))
            .or_else(|| wins.iter().find(|w| w.pid == pid && w.layer == 0))
            .or_else(|| wins.iter().find(|w| w.pid == pid))
            .map(|w| (w.window_id, w.bounds))
    };
    let Some((window_id, win_bounds)) = target_win else {
        log::warn!("capture_pick_crop: no window for pid {} — skipping crop", pid);
        return;
    };
    let dir = app.state::<OutputDir>().inner().0.clone();
    let _ = std::fs::create_dir_all(&dir);
    let seq = PICK_CROP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let out = dir.join(format!("pick-crop-{}-{}-{}.png", pid, stamp, seq));
    let out_for_task = out.clone();
    let res = tokio::task::spawn_blocking(move || {
        vibe_extract_core::screenshot::capture_window_crop(window_id, win_bounds, elem, &out_for_task)
    })
    .await;
    match res {
        Ok(Ok(())) => {
            log::info!("capture_pick_crop: saved {}", out.display());
            picked.crop_path = Some(out.to_string_lossy().into_owned());
        }
        Ok(Err(e)) => log::warn!("capture_pick_crop: failed: {}", e),
        Err(e) => log::warn!("capture_pick_crop: task join error: {}", e),
    }
}

/// Depth cap for the pick-time AX subtree walk — matches the live `ax_subtree_at_point`
/// default and the dispatcher's window walk.
const PICK_AX_MAX_DEPTH: u32 = 25;
/// Node cap so a pathological tree can't bloat `last-selection.json` / RAM. On overflow
/// we drop the tree (leave `None`) rather than ship a truncated, misleading structure.
#[cfg(target_os = "macos")]
const PICK_AX_MAX_NODES: usize = 4000;

/// Capture the FULL AX subtree rooted at the SAME element the user picked, NOW — while
/// the target app is running (call BEFORE any freeze; a SIGSTOP'd app can't answer AX).
/// Sets `picked.ax_tree` so `/replicate-ui` has the element's structure even after the
/// app is closed/backgrounded. Best-effort; shallow (Electron) picks are skipped — their
/// subtree is a meaningless placeholder, so the CDP / `extract_component` path re-resolves
/// them. Used by the mouse path (`overlay_click`); the keyboard ↑/↓ path captures inline.
#[cfg(target_os = "macos")]
async fn capture_pick_ax_tree(picked: &mut PickedElement) {
    if picked.ax_shallow {
        return;
    }
    let pid = picked.pid;
    let snapshot = picked.clone();
    let res = tokio::task::spawn_blocking(move || {
        // Re-resolve the SAME element (climb to matching bounds), then walk its subtree.
        let el = reacquire_current(Some(pid), &snapshot)?;
        let node = vibe_extract_core::ax_macos::walk_node(&el, PICK_AX_MAX_DEPTH);
        if vibe_extract_core::ax_macos::count_nodes(&node) > PICK_AX_MAX_NODES {
            return None;
        }
        Some(node)
    })
    .await;
    match res {
        Ok(Some(node)) => {
            log::info!(
                "capture_pick_ax_tree: {} nodes for pid {}",
                vibe_extract_core::ax_macos::count_nodes(&node),
                pid
            );
            picked.ax_tree = Some(node);
        }
        Ok(None) => log::info!(
            "capture_pick_ax_tree: no tree for pid {} (reacquire failed or over cap)",
            pid
        ),
        Err(e) => log::warn!("capture_pick_ax_tree: task join error: {}", e),
    }
}

#[cfg(not(target_os = "macos"))]
async fn capture_pick_ax_tree(_picked: &mut PickedElement) {}

/// Persist the current selection to `last-selection.json` (read by the MCP
/// `get_selection` tool) and push the outlines + count to the overlay/main UI.
fn persist_and_broadcast(app: &AppHandle, list: &[PickedElement]) {
    let dir = app.state::<OutputDir>().inner().0.clone();
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(js) = serde_json::to_string(list) {
        let _ = std::fs::write(dir.join("last-selection.json"), js);
    }
    if let Some(overlay) = app.get_webview_window("overlay") {
        let payload: Vec<OverlaySelectedPayload> = list
            .iter()
            .map(|p| OverlaySelectedPayload {
                bounds: to_overlay_bounds(&p.bounds),
                role: p.role.clone(),
                name: p.name.clone(),
            })
            .collect();
        let _ = overlay.emit("overlay-selections", payload);
    }
    let _ = app.emit("selection-count-changed", list.len());
}

/// Freeze the picked app (SIGSTOP) so its hover panel can't close while the cursor
/// roams freely; record its pid in the session AND the lock-free recovery record.
/// The SOLE writer of a freeze (with `unfreeze_app`). Resumes any previously-frozen
/// DIFFERENT app first (no overwrite-leak) and refuses to record a dead pid. No-op off macOS.
fn freeze_app(freeze_pid: &mut Option<i32>, pid: i32) {
    #[cfg(target_os = "macos")]
    {
        // Resume any previously-frozen different app before overwriting — never orphan it.
        if let Some(old) = *freeze_pid {
            if old != pid {
                vibe_extract_core::app_freeze_macos::resume(old);
            }
        }
        // Don't record a dead/recycled pid as frozen (suspend already no-ops on it).
        if !vibe_extract_core::app_freeze_macos::is_alive(pid) {
            *freeze_pid = None;
            clear_freeze_record();
            return;
        }
        vibe_extract_core::app_freeze_macos::suspend(pid);
    }
    *freeze_pid = Some(pid);
    record_freeze(pid);
}

/// Resume a frozen app (SIGCONT) and clear both the session flag and the recovery
/// record. Returns the pid that was frozen so the caller can re-freeze it after a
/// brief live operation (e.g. an AX query). The SOLE clearer of a freeze.
fn unfreeze_app(freeze_pid: &mut Option<i32>) -> Option<i32> {
    let p = freeze_pid.take();
    #[cfg(target_os = "macos")]
    if let Some(pid) = p {
        vibe_extract_core::app_freeze_macos::resume(pid);
    }
    clear_freeze_record();
    p
}

#[tauri::command]
async fn overlay_click(
    app: AppHandle,
    screen_x: f64,
    screen_y: f64,
    shift: bool,
) -> Result<String, String> {
    log::info!(
        "overlay_click at ({:.0}, {:.0}) shift={}",
        screen_x, screen_y, shift
    );

    // Hit-test at the click point on the underlying screen.
    let point = ScreenPoint {
        x: screen_x,
        y: screen_y,
    };
    let target_pid_opt = {
        let s = app.state::<PickSessionState>();
        let mut guard = s.0.lock().unwrap();
        // If an app is frozen from a previous pick, resume it so this pick's AX +
        // crop run on a live app. Its stale hover is useless now → force a fresh
        // hit-test below by clearing last_hover.
        if unfreeze_app(&mut guard.freeze_pid).is_some() {
            guard.last_hover = None;
        }
        guard.target_pid
    };

    // PREFER the last-hovered element. This is what the overlay was visually
    // outlining the moment the user clicked — matches the web extension's
    // `hoverElement` approach. Falls back to a fresh hit-test only if no
    // hover was cached (e.g. first frame after pick mode starts).
    //
    // BUT: validate the cached element's pid first. The hover task already
    // filters foreign-pid hits, but belt-and-suspenders here catches any
    // edge case where a stale or wrong-app cache slipped through. Without
    // this guard, a click would commit VibeExtract's own AXMenuBar when
    // Apple's global hit-test leaked one in.
    let our_pid_local: i32 = std::process::id() as i32;
    let pick_result: Result<PickedElement, String> = {
        let cached_hover = {
            let s = app.state::<PickSessionState>();
            let guard = s.0.lock().unwrap();
            guard.last_hover.clone()
        };
        let cached_hover = cached_hover.filter(|hover| {
            if hover.pid == our_pid_local {
                log::warn!(
                    "overlay_click: rejecting cached hover from our own pid={} role={}",
                    hover.pid, hover.role
                );
                return false;
            }
            if let Some(want) = target_pid_opt {
                if hover.pid != want {
                    log::warn!(
                        "overlay_click: rejecting cached hover from pid={} (want target_pid={})",
                        hover.pid, want
                    );
                    return false;
                }
            }
            // Note: we used to reject AXMenuBar/AXMenuBarItem/AXApplication
            // here too, but Apple's AX hit-test routinely returns those for
            // Slack/Electron content even mid-screen, leaving the user
            // unable to click anything. Accept them — the dispatcher will
            // gracefully fall through to the screenshot fallback when the
            // AX subtree is empty.
            true
        });
        match cached_hover {
            Some(hover) => {
                log::info!(
                    "overlay_click: using cached hover element {} \"{}\" pid={}",
                    hover.role, hover.name, hover.pid
                );
                Ok(hover)
            }
            None => {
                #[cfg(target_os = "macos")]
                {
                    match target_pid_opt {
                        Some(pid) => vibe_extract_core::ax_macos::pick_in_app(point, pid)
                            .map_err(|e| e.to_string()),
                        None => vibe_extract_core::picker::pick_under_cursor(Some(point))
                            .map_err(|e| e.to_string()),
                    }
                }
                #[cfg(not(target_os = "macos"))]
                {
                    vibe_extract_core::picker::pick_under_cursor(Some(point))
                        .map_err(|e| e.to_string())
                }
            }
        }
    };

    let mut picked = match pick_result {
        Ok(p) => {
            // Only reject if the click somehow landed in VibeExtract's own
            // process — that would never produce useful output. Accept
            // AXMenuBar/AXApplication: the dispatcher's screenshot fallback
            // will produce a meaningful result even when AX is too shallow.
            if p.pid == our_pid_local {
                log::warn!(
                    "overlay_click: rejecting fresh-hit from our own pid={} role={}",
                    p.pid, p.role
                );
                let _ = app.emit(
                    "toast",
                    "Cursor is over VibeExtract itself — click on the target app.",
                );
                return Err("fresh hit was our own process".into());
            }
            log::info!(
                "overlay_click pick succeeded: role={} name=\"{}\" pid={}",
                p.role, p.name, p.pid
            );
            p
        }
        Err(e) => {
            log::warn!("overlay_click pick FAILED: {}", e);
            let _ = app.emit(
                "toast",
                format!(
                    "Click ignored: {} — make sure the target app is frontmost and your cursor is over a real UI element.",
                    e
                ),
            );
            return Err(e);
        }
    };

    // The AX hit-test may only have found a shallow container: Electron web
    // content (Slack / VS Code sidebars, messages) isn't exposed to macOS AX, so
    // `AXUIElementCopyElementAtPosition` returns a top-level element — often the
    // menu bar at {0,0,W,30} — instead of what the user clicked. Escalate
    // NON-DISRUPTIVELY: wake the app's AX tree and retry once after a short wait
    // (AXManualAccessibility frequently exposes a fuller tree). We keep the TRUE
    // click point no matter what, so `/replicate-ui` can re-resolve the precise
    // element via the CDP ladder even when AX stays shallow.
    #[cfg(target_os = "macos")]
    {
        if picked.ax_shallow && picked.pid > 0 {
            log::info!(
                "overlay_click: AX result shallow (role={} doesn't pin the click) — waking pid={} + retrying",
                picked.role, picked.pid
            );
            {
                let s = app.state::<PickSessionState>();
                s.0.lock().unwrap().woken_pids.insert(picked.pid);
            }
            vibe_extract_core::ax_macos::wake_app_ax(picked.pid);
            tokio::time::sleep(std::time::Duration::from_millis(220)).await;
            if let Ok(repicked) = vibe_extract_core::ax_macos::pick_in_app(point, picked.pid) {
                if !repicked.ax_shallow {
                    log::info!(
                        "overlay_click: wake+retry resolved a real element: role={} name=\"{}\"",
                        repicked.role, repicked.name
                    );
                    picked = repicked;
                } else {
                    log::info!(
                        "overlay_click: still shallow after wake+retry — Electron web content not in AX; keeping click point for CDP re-resolve"
                    );
                }
            }
        }
    }

    // Always anchor the committed pick to the TRUE click point. When AX is still
    // shallow, replace the misleading container bounds (e.g. the menu bar) with a
    // click-CENTERED box: the overlay highlight + in-app ⌘⇧E export then target
    // where the user actually clicked (the dispatcher uses `bounds.center()` for
    // its CDP at-point lookup, which now equals the click), and `/replicate-ui`
    // re-resolves the precise element via `extract_component` at `click`.
    picked.click = Some(point);
    if picked.ax_shallow {
        let (half_w, half_h) = (90.0_f64, 24.0_f64);
        picked.bounds = vibe_extract_core::capture::ScreenRect {
            x: point.x - half_w,
            y: point.y - half_h,
            w: half_w * 2.0,
            h: half_h * 2.0,
        };
    }

    // Capture the element's pixels NOW, while the target app is frontmost (the
    // user just clicked it). We grab the owning window by its CG id via
    // `screencapture -l` and crop to the (final) element bounds — immune to our
    // pick overlay's highlight border AND to later occlusion, so `get_selection`
    // can hand `/replicate-ui` the real pixels even after the app is closed.
    // Strictly best-effort: any failure leaves `crop_path = None` and never
    // blocks the pick.
    //
    // SKIP for shallow (Electron) picks: there `bounds` is a click-centered
    // placeholder box (set above), NOT the real element, so a crop of it would be
    // a meaningless slice. Leaving crop_path = None is exactly the signal
    // /replicate-ui uses to re-resolve via extract_component at the click point.
    //
    // NOTE: the capture (screencapture + decode + crop) is awaited inline, so a
    // successful capture adds ~150-300ms before the highlight updates. Acceptable
    // for now; could be detached + back-filled if pick latency becomes an issue.
    // Capture the element's pixels NOW (occlusion-immune, cropped to the final
    // bounds) so /replicate-ui has them even after the app closes. Shallow picks
    // skip inside the helper (their bounds are a click placeholder → re-resolved
    // via CDP later).
    capture_pick_crop(&app, &mut picked).await;
    // Capture the element's AX subtree NOW — app still running, before any freeze — so
    // /replicate-ui has the structure even after the app closes (Problem 4). Shallow
    // (Electron) picks skip inside the helper (re-resolved via the CDP path later).
    #[cfg(target_os = "macos")]
    capture_pick_ax_tree(&mut picked).await;

    // Single-app lock (Problem 2): once a session is locked to an app, EVERY click
    // (shift or not) must land in that app; a click elsewhere is rejected until Esc.
    let state = app.state::<PickSessionState>();
    // Crop files of a selection we're about to discard (fresh non-shift pick),
    // so the output dir doesn't accumulate orphaned pick-crop PNGs over a session.
    let mut dropped_crops: Vec<String> = Vec::new();
    // Resolve the click against the lock in ONE critical section, then act on the
    // outcome (toast/return or proceed) after releasing the mutex.
    enum ClickOutcome {
        Inactive,
        CrossApp(i32),
        Committed(Vec<PickedElement>),
    }
    let outcome = {
        let mut s = state.0.lock().unwrap();
        if !s.active {
            ClickOutcome::Inactive
        } else if let Some(locked) = s.locked_pid.filter(|&l| l != picked.pid) {
            ClickOutcome::CrossApp(locked)
        } else {
            // Lazy-lock on the first pick (armed with VibeExtract frontmost → target_pid
            // was None); also scope the hover hit-test to this app from now on.
            if s.locked_pid.is_none() {
                s.locked_pid = Some(picked.pid);
                s.target_pid = Some(picked.pid);
            }
            if shift {
                s.selected.push(picked.clone());
            } else {
                dropped_crops.extend(s.selected.iter().filter_map(|e| e.crop_path.clone()));
                s.selected.clear();
                s.selected.push(picked.clone());
                // A fresh click is a new nav anchor — drop any keyboard-walk path.
                s.nav_stack.clear();
                s.nav_active = false;
                s.nav_anchor_cursor = None;
            }
            // Freeze the picked app so its hover panel stays open while the cursor roams
            // during ↑/↓ refine (SIGSTOP). Released on Enter (commit) / Esc / stop, and
            // by the safety net. Same pid as the lock → re-freezing the same app is fine.
            freeze_app(&mut s.freeze_pid, picked.pid);
            ClickOutcome::Committed(s.selected.clone())
        }
    };
    let new_selected_list = match outcome {
        ClickOutcome::Inactive => return Err("pick mode not active".into()),
        ClickOutcome::CrossApp(locked) => {
            #[cfg(target_os = "macos")]
            let name = app_name_for_pid(locked).unwrap_or_else(|| format!("pid {}", locked));
            #[cfg(not(target_os = "macos"))]
            let name = format!("pid {}", locked);
            let _ = app.emit("toast", format!("Locked to {} — press Esc to switch apps.", name));
            return Err(format!("cross-app selection blocked (locked to pid {})", locked));
        }
        ClickOutcome::Committed(list) => list,
    };
    // Best-effort GC of the superseded selection's crops (outside the lock).
    for p in dropped_crops {
        let _ = std::fs::remove_file(p);
    }

    // Persist for the MCP `get_selection` tool + push outlines/count to the UI.
    persist_and_broadcast(&app, &new_selected_list);
    // The target is now SIGSTOP-frozen for ↑/↓ refinement — surface a banner so the
    // pause reads as intentional (not a crash) and tell the user how to lock/cancel.
    if let Some(overlay) = app.get_webview_window("overlay") {
        let _ = overlay.emit("overlay-status", REFINE_BANNER);
    }
    log::info!(
        "overlay_click: selection list now has {} element(s)",
        new_selected_list.len()
    );

    Ok(format!(
        "selected {} ({})",
        new_selected_list.len(),
        picked.role
    ))
}

#[tauri::command]
async fn export_selection(app: AppHandle) -> Result<ExportPayload, String> {
    // Single-flight: refuse if another export is already in flight. The CDP
    // path can take up to 15s; without this guard, the user spamming ⌘⇧E
    // spawns N concurrent dispatchers and the UI never settles.
    {
        let guard_state = app.state::<ExportInProgressState>();
        let mut g = guard_state.0.lock().unwrap();
        if *g {
            return Err(
                "an export is already in progress — give it a moment to finish".into(),
            );
        }
        *g = true;
    }
    // RAII drop so the flag clears no matter how we exit (Ok, Err, panic).
    struct ExportGuard<'a>(&'a AppHandle);
    impl<'a> Drop for ExportGuard<'a> {
        fn drop(&mut self) {
            if let Some(s) = self.0.try_state::<ExportInProgressState>() {
                *s.0.lock().unwrap() = false;
            }
        }
    }
    let _export_guard = ExportGuard(&app);

    let (selected, _) = {
        let state = app.state::<PickSessionState>();
        let s = state.0.lock().unwrap();
        (s.selected.clone(), s.active)
    };
    if selected.is_empty() {
        return Err("nothing selected".into());
    }
    // The extractor needs the target LIVE: a SIGSTOP-frozen app can't answer AX or
    // CDP — the debug-port probe times out and misreads as "needs relaunch", which
    // popped a spurious restart dialog on ⌘⇧E even for apps already in debug mode.
    // The pick-time crop already preserved the frozen pixels, so resume it now
    // (the soft reset below keeps it resumed anyway).
    {
        let state = app.state::<PickSessionState>();
        let mut s = state.0.lock().unwrap();
        unfreeze_app(&mut s.freeze_pid);
    }
    let out_dir = app.state::<OutputDir>().inner().0.clone();

    // Hide the overlay BEFORE running the extractor so its screenshot step
    // doesn't capture our own HUD/outline pixels. NOTE: do NOT move the
    // window off-screen — that's been observed to "stick" so the overlay
    // doesn't come back properly on the next start_pick_mode call.
    let t_export = std::time::Instant::now();
    if let Some(overlay) = app.get_webview_window("overlay") {
        let _ = overlay.set_ignore_cursor_events(true);
        let _ = overlay.hide();
    }
    tokio::time::sleep(std::time::Duration::from_millis(180)).await;
    log::info!(
        "export_selection: capturing {} element(s) after overlay hidden",
        selected.len()
    );

    let first_attempt = dispatcher::extract_multi(&selected, CONTENT_SCRIPT, &out_dir).await;
    let mut result = match first_attempt {
        Ok(r) => r,
        Err(ExtractError::ElectronNeedsRelaunch {
            bundle_id,
            display_name,
            ..
        }) => {
            match handle_electron_relaunch_flow(&app, bundle_id, display_name.clone()).await {
                RelaunchOutcome::RelaunchedRearmed => {
                    // User must re-pick now; we return early with a friendly
                    // sentinel error so the toast in the main window explains.
                    return Err(format!(
                        "{} restarted in debug mode — re-pick your element then press ⌘⇧E",
                        display_name
                    ));
                }
                RelaunchOutcome::UseAxFallback => {
                    // Re-run with skip_relaunch=true so the dispatcher does
                    // the AX path instead of looping back to us.
                    let r = dispatcher::extract_multi_with_opts(
                        &selected,
                        CONTENT_SCRIPT,
                        &out_dir,
                        true,
                    )
                    .await
                    .map_err(|e| e.to_string())?;
                    // The AX path on Electron almost always degrades to
                    // screenshot-only (shallow tree). Tell the user clearly
                    // so they know their pixel-perfect option is still one
                    // dialog away. We use `display_name` captured at the
                    // start of this match arm.
                    if r.strategy.contains("screenshot_only") {
                        let _ = app.emit(
                            "toast",
                            format!(
                                "{}'s AX tree was empty — only a screenshot was captured. For real DOM, accept the restart prompt or set 'Always' in Settings → Electron Apps.",
                                display_name
                            ),
                        );
                    }
                    r
                }
            }
        }
        Err(e) => return Err(e.to_string()),
    };
    result.diagnostics.push(format!(
        "export total {}ms (incl. 180ms overlay settle)",
        t_export.elapsed().as_millis()
    ));

    // SOFT reset: keep pick mode active (overlay visible, event tap installed,
    // Esc still bound) so the user can immediately click another element and
    // press ⌘⇧E again without re-arming. Clear `selected` so their next click
    // starts a fresh pick instead of accumulating onto the previous one.
    // Re-show the overlay because export_selection hid it before extracting.
    {
        let state = app.state::<PickSessionState>();
        let mut s = state.0.lock().unwrap();
        s.selected.clear();
        s.locked_pid = None;
        s.last_hover = None;
        s.nav_stack.clear();
        s.nav_active = false;
        s.nav_anchor_cursor = None;
        unfreeze_app(&mut s.freeze_pid); // resume any frozen app (SIGCONT)
    }
    let _ = app.emit("selection-count-changed", 0);
    if let Some(overlay) = app.get_webview_window("overlay") {
        let active = app
            .try_state::<PickSessionState>()
            .map(|s| s.0.lock().unwrap().active)
            .unwrap_or(false);
        if active {
            let _ = overlay.show();
            let _ = overlay.set_ignore_cursor_events(true);
        }
    }

    let summary = selected
        .iter()
        .map(|p| format!("{} \"{}\"", p.role, p.name))
        .collect::<Vec<_>>()
        .join(" + ");

    Ok(ExportPayload {
        strategy: result.strategy,
        fidelity: result.fidelity,
        toon: result.toon,
        html: result.html,
        screenshot_png_b64: result.screenshot_png_b64,
        diagnostics: result.diagnostics,
        ax_tree: result.ax_tree,
        picked_summary: summary,
        count: selected.len(),
    })
}

#[tauri::command]
async fn extract_frontmost_window_cmd(app: AppHandle) -> Result<ExportPayload, String> {
    let out_dir = app.state::<OutputDir>().inner().0.clone();
    let first_attempt = dispatcher::extract_frontmost_window(CONTENT_SCRIPT, &out_dir).await;
    let result = match first_attempt {
        Ok(r) => r,
        Err(ExtractError::ElectronNeedsRelaunch {
            bundle_id,
            display_name,
            ..
        }) => match handle_electron_relaunch_flow(&app, bundle_id, display_name.clone()).await {
            RelaunchOutcome::RelaunchedRearmed => {
                return Err(format!(
                    "{} restarted in debug mode — re-pick your element then press ⌘⇧E",
                    display_name
                ));
            }
            RelaunchOutcome::UseAxFallback => dispatcher::extract_frontmost_window_with_opts(
                CONTENT_SCRIPT,
                &out_dir,
                true,
            )
            .await
            .map_err(|e| e.to_string())?,
        },
        Err(e) => return Err(e.to_string()),
    };
    Ok(ExportPayload {
        strategy: result.strategy,
        fidelity: result.fidelity,
        toon: result.toon,
        html: result.html,
        screenshot_png_b64: result.screenshot_png_b64,
        diagnostics: result.diagnostics,
        ax_tree: result.ax_tree,
        picked_summary: "entire frontmost window".into(),
        count: 1,
    })
}

// =============================================================================
// Electron auto-relaunch orchestration
// =============================================================================
//
// When the dispatcher returns `ExtractError::ElectronNeedsRelaunch`, the Tauri
// layer is responsible for the user-facing flow: read the per-app preference,
// optionally pop the modal, quit-and-relaunch via `electron_relaunch`, and re-
// arm pick mode so the user can re-pick at the now-open debug port.

#[derive(Debug, Clone, Copy)]
enum RelaunchOutcome {
    /// Relaunched successfully and pick mode is now armed — user must re-pick.
    /// No CaptureResult this round.
    RelaunchedRearmed,
    /// User declined OR pref was AlwaysNo OR relaunch failed. Caller should
    /// re-run extract_* with `skip_relaunch=true` to get the AX fallback.
    UseAxFallback,
}

async fn handle_electron_relaunch_flow(
    app: &AppHandle,
    bundle_id: String,
    display_name: String,
) -> RelaunchOutcome {
    // Single-flight guard.
    {
        let guard_state = app.state::<RelaunchInProgressState>();
        let mut g = guard_state.0.lock().unwrap();
        if *g {
            let _ = app.emit(
                "toast",
                format!("Already relaunching {} — please wait…", display_name),
            );
            return RelaunchOutcome::UseAxFallback;
        }
        *g = true;
    }
    // Make sure we drop the guard no matter how we exit.
    struct Guard<'a>(&'a AppHandle);
    impl<'a> Drop for Guard<'a> {
        fn drop(&mut self) {
            if let Some(s) = self.0.try_state::<RelaunchInProgressState>() {
                *s.0.lock().unwrap() = false;
            }
        }
    }
    let _guard = Guard(app);

    // CRITICAL: tear down the active pick-mode plumbing (event tap, overlay,
    // Esc shortcut) BEFORE showing the dialog. Otherwise the global mouse tap
    // captures every click on the dialog itself, the user can't interact
    // properly, and spurious AX hits poison the selection state. We
    // deliberately PRESERVE `selected` and `locked_pid` — they're the
    // user's original picks, which the AX-fallback path needs intact if the
    // user cancels.
    {
        let state = app.state::<PickSessionState>();
        let mut s = state.0.lock().unwrap();
        s.active = false;
        s.last_hover = None;
        s.nav_stack.clear();
        s.nav_active = false;
        s.nav_anchor_cursor = None;
        unfreeze_app(&mut s.freeze_pid); // resume any frozen app (SIGCONT)
        // intentional: do NOT clear selected, locked_pid, or woken_pids
    }
    #[cfg(target_os = "macos")]
    {
        let tap_state = app.state::<EventTapState>();
        let mut guard = tap_state.0.lock().unwrap();
        if guard.is_some() {
            drop(guard.take());
            log::info!("event_tap: dropped for relaunch dialog");
        }
    }
    if let Some(overlay) = app.get_webview_window("overlay") {
        let _ = overlay.set_ignore_cursor_events(true);
        let _ = overlay.hide();
    }
    // Same pick-mode shortcut set as start/stop_pick_mode — drop them all so
    // they don't fire while the dialog is up.
    for s in [
        Shortcut::new(None, Code::Escape),
        Shortcut::new(None, Code::Enter),
        Shortcut::new(None, Code::ArrowUp),
        Shortcut::new(None, Code::ArrowDown),
    ] {
        let _ = app.global_shortcut().unregister(s);
    }
    let _ = app.emit("pick-mode-changed", false);

    let pref = settings::get_electron_pref(&bundle_id);
    log::info!(
        "electron_relaunch: bundle={} display={} pref={:?}",
        bundle_id, display_name, pref
    );

    let proceed = match pref {
        ElectronRelaunchPref::AlwaysNo => false,
        ElectronRelaunchPref::AlwaysYes => true,
        ElectronRelaunchPref::Ask => {
            let known = electron_relaunch::lookup_known(&bundle_id).is_some();
            let info = RelaunchDialogInfo {
                bundle_id: bundle_id.clone(),
                display_name: display_name.clone(),
                known,
            };
            match show_relaunch_dialog(app, info).await {
                Some(choice) => {
                    if choice.dont_ask {
                        let pref = if choice.accept {
                            ElectronRelaunchPref::AlwaysYes
                        } else {
                            ElectronRelaunchPref::AlwaysNo
                        };
                        if let Err(e) = settings::set_electron_pref(&bundle_id, pref) {
                            log::warn!("settings save failed: {}", e);
                        }
                    }
                    choice.accept
                }
                None => {
                    // Dialog window failed to open. Treat as cancel.
                    false
                }
            }
        }
    };

    if !proceed {
        return RelaunchOutcome::UseAxFallback;
    }

    // Build the RelaunchTarget. Known apps use the static AppleScript aliases;
    // unknown apps use display_name as both the alias and AppleScript target.
    let target = match electron_relaunch::make_target(Some(&bundle_id), &display_name) {
        Ok(t) => t,
        Err(e) => {
            log::warn!("make_target failed: {}", e);
            let _ = app.emit("toast", format!("Can't relaunch {}: {}", display_name, e));
            return RelaunchOutcome::UseAxFallback;
        }
    };

    // Emit the dialog's listener can pick up — the dialog stays open in
    // progress view while this runs. `forward_to_dialog` is closed over so
    // both the dialog and the main window see the same progress stream.
    let app_for_progress = app.clone();
    let result = electron_relaunch::quit_and_relaunch(&target, move |p| {
        let _ = app_for_progress.emit("electron-relaunch-progress", p);
    })
    .await;

    // Whether the relaunch succeeded or failed, we're done with the dialog —
    // hide it so the user sees either the toast (success → "re-pick") or
    // the failure toast unobstructed. A brief delay on success keeps the
    // "Ready" checkmark visible for a beat instead of snapping shut.
    if result.is_ok() {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    if let Some(win) = app.get_webview_window("relaunch-dialog") {
        let _ = win.hide();
    }

    match result {
        Ok(port) => {
            log::info!(
                "electron_relaunch: success — {} now on debug port {}",
                display_name, port
            );
            let _ = app.emit(
                "toast",
                format!(
                    "{} is ready — press ⌘⇧S then re-pick your element",
                    display_name
                ),
            );
            // Auto-arm pick mode so the user can immediately re-pick.
            // Small delay so the toast has time to render and the app has a
            // moment to finish drawing its window.
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            let app_for_pick = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = start_pick_mode(app_for_pick).await {
                    log::warn!("auto start_pick_mode after relaunch failed: {}", e);
                }
            });
            RelaunchOutcome::RelaunchedRearmed
        }
        Err(e) => {
            log::warn!("electron_relaunch failed: {}", e);
            let _ = app.emit(
                "toast",
                format!("Couldn't restart {}: {} — using AX path", display_name, e),
            );
            RelaunchOutcome::UseAxFallback
        }
    }
}

/// Open the relaunch-dialog modal, return the user's choice (or `None` if the
/// dialog window couldn't be opened).
async fn show_relaunch_dialog(
    app: &AppHandle,
    info: RelaunchDialogInfo,
) -> Option<RelaunchDialogChoice> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    {
        let state = app.state::<RelaunchDialogState>();
        let mut g = state.0.lock().unwrap();
        // If a dialog is already up (shouldn't happen due to single-flight,
        // but guard anyway) reject the previous request.
        if let Some(prev) = g.take() {
            let _ = prev.tx.send(RelaunchDialogChoice {
                accept: false,
                dont_ask: false,
            });
        }
        *g = Some(RelaunchDialogPending {
            info: info.clone(),
            tx,
        });
    }
    let Some(win) = app.get_webview_window("relaunch-dialog") else {
        log::warn!("relaunch-dialog window not found");
        return None;
    };
    let _ = win.show();
    let _ = win.set_focus();
    let _ = win.center();
    // The dialog window was created at app launch (visible: false) so its JS
    // already ran ONCE before any state existed. Tauri doesn't re-run scripts
    // on subsequent show()s, so we can't rely on the script's initial load()
    // to populate the title/question. Instead emit an event the dialog's
    // (persistent) listener picks up to refresh its UI.
    let _ = win.emit("relaunch-dialog-show", &info);

    // Wait for the user's response. 60s budget — more than enough for them to
    // read a one-line question and click a button. If they walk away we
    // default to cancel.
    match tokio::time::timeout(std::time::Duration::from_secs(60), rx).await {
        Ok(Ok(choice)) => Some(choice),
        _ => {
            // Clean up state on timeout.
            let state = app.state::<RelaunchDialogState>();
            *state.0.lock().unwrap() = None;
            let _ = win.hide();
            None
        }
    }
}

#[tauri::command]
async fn get_relaunch_dialog_info(app: AppHandle) -> Result<RelaunchDialogInfo, String> {
    let state = app.state::<RelaunchDialogState>();
    let g = state.0.lock().unwrap();
    match g.as_ref() {
        Some(p) => Ok(p.info.clone()),
        None => Err("no pending relaunch dialog".into()),
    }
}

#[tauri::command]
async fn relaunch_dialog_response(
    app: AppHandle,
    accept: bool,
    dont_ask: bool,
) -> Result<(), String> {
    let pending = {
        let state = app.state::<RelaunchDialogState>();
        let mut g = state.0.lock().unwrap();
        g.take()
    };
    // Hide the dialog only if the user CANCELLED — otherwise keep it open so
    // it can display the restart progress (spinner + phase + elapsed). The
    // dialog is hidden later by `handle_electron_relaunch_flow` once
    // `quit_and_relaunch` returns.
    if !accept {
        if let Some(win) = app.get_webview_window("relaunch-dialog") {
            let _ = win.hide();
        }
    }
    if let Some(p) = pending {
        let _ = p.tx.send(RelaunchDialogChoice { accept, dont_ask });
        Ok(())
    } else {
        Err("no pending relaunch dialog".into())
    }
}

#[tauri::command]
async fn get_settings_cmd() -> Result<VibeExtractSettings, String> {
    Ok(settings::load())
}

#[tauri::command]
async fn set_electron_pref_cmd(bundle_id: String, pref: String) -> Result<(), String> {
    let parsed = match pref.as_str() {
        "ask" => ElectronRelaunchPref::Ask,
        "always_yes" => ElectronRelaunchPref::AlwaysYes,
        "always_no" => ElectronRelaunchPref::AlwaysNo,
        other => return Err(format!("unknown pref '{}'", other)),
    };
    settings::set_electron_pref(&bundle_id, parsed).map_err(|e| e.to_string())
}

#[tauri::command]
async fn known_electron_apps() -> Vec<KnownAppLite> {
    electron_relaunch::KNOWN_ELECTRON_APPS
        .iter()
        .map(|k| KnownAppLite {
            bundle_id: k.bundle_id.to_string(),
            display_name: k.display_name.to_string(),
        })
        .collect()
}

#[derive(Serialize, Deserialize, Clone)]
struct KnownAppLite {
    bundle_id: String,
    display_name: String,
}

/// Walk up (parent) or down (deepest descendant under cursor) the AX
/// ancestry of the currently hovered element. Updates `last_hover` and emits
/// the new outline to the overlay so the user immediately sees the bigger /
/// smaller region. Bound to ↑ / ↓ while pick mode is active.
#[cfg(target_os = "macos")]
async fn walk_hover_ancestry(app: AppHandle, go_up: bool) -> Result<(), String> {
    // For an Electron target the hover is CDP-driven: ↑/↓ adjust how many extra
    // DOM-parent steps to widen by, then RE-PROBE HERE and commit the result.
    // (Deferring to the hover task's next tick doesn't work after a pick: the
    // target is SIGSTOP-frozen, so that task bails at its frozen-app guard and
    // the arrows visibly did nothing. A frozen app can't answer CDP either, so
    // resume it around the probe, same lifecycle as the AX walk below.)
    let cdp_ctx = {
        let state = app.state::<PickSessionState>();
        let mut s = state.0.lock().unwrap();
        if !s.active {
            return Err("pick mode not active".into());
        }
        match (s.cdp_port, s.target_win) {
            (Some(port), Some(win)) => {
                s.widen_level = if go_up {
                    s.widen_level.saturating_add(1)
                } else {
                    s.widen_level.saturating_sub(1)
                };
                let anchor = s
                    .selected
                    .last()
                    .or(s.last_hover.as_ref())
                    .map(|p| p.click.unwrap_or_else(|| p.bounds.center()));
                let frozen = unfreeze_app(&mut s.freeze_pid);
                Some((port, win, s.widen_level, s.target_pid, anchor, frozen))
            }
            _ => None,
        }
    };
    if let Some((port, win, widen, tpid, anchor, frozen_pid)) = cdp_ctx {
        let refreeze = |app: &AppHandle| {
            if let Some(pid) = frozen_pid {
                let st = app.state::<PickSessionState>();
                let mut s = st.0.lock().unwrap();
                if s.active {
                    freeze_app(&mut s.freeze_pid, pid);
                }
            }
        };
        let Some(pt) = anchor else {
            refreeze(&app);
            return Err("no element to walk from".into());
        };
        let hit = match vibe_extract_core::cdp::probe_at(port, 0, pt.x - win.x, pt.y - win.y, widen)
            .await
        {
            Ok(Some(hit)) => hit,
            Ok(None) => {
                refreeze(&app);
                return Err("nothing at the anchor point (CDP)".into());
            }
            Err(e) => {
                refreeze(&app);
                return Err(format!("CDP probe failed: {e}"));
            }
        };
        let bounds = vibe_extract_core::capture::ScreenRect {
            x: hit.x + win.x,
            y: hit.y + win.y,
            w: hit.w,
            h: hit.h,
        };
        let label = if hit.label.is_empty() { hit.tag.clone() } else { hit.label.clone() };
        let role = if hit.role.is_empty() { format!("dom:{}", hit.tag) } else { hit.role.clone() };
        let picked = PickedElement {
            role: role.clone(),
            subrole: None,
            name: label.clone(),
            identifier: None,
            bounds,
            pid: tpid.unwrap_or(-1),
            app_path: tpid.and_then(vibe_extract_core::ax_macos::pid_to_path),
            window_title: None,
            window_bounds: Some(win),
            click: Some(pt),
            ax_shallow: false,
            crop_path: None,
            ax_tree: None,
        };
        let cursor = vibe_extract_core::ax_macos::current_cursor();
        // INSTANT commit + re-freeze, mirroring the AX path below: selection and
        // highlight move now; the pixel crop back-fills in the background.
        let list = {
            let state = app.state::<PickSessionState>();
            let mut s = state.0.lock().unwrap();
            if !s.active {
                return Err("pick mode not active".into());
            }
            if let Some(pid) = frozen_pid {
                freeze_app(&mut s.freeze_pid, pid);
            }
            s.selected.clear();
            s.selected.push(picked.clone());
            s.locked_pid = Some(picked.pid);
            s.last_hover = Some(picked.clone());
            s.nav_active = true;
            s.nav_anchor_cursor = Some(cursor);
            s.selected.clone()
        };
        persist_and_broadcast(&app, &list);
        if let Some(overlay) = app.get_webview_window("overlay") {
            let _ = overlay.emit(
                "overlay-hover",
                OverlayHoverPayload {
                    bounds: Some(OverlayBounds {
                        x: bounds.x,
                        y: bounds.y,
                        w: bounds.w,
                        h: bounds.h,
                    }),
                    role,
                    name: label,
                    cursor: OverlayCursor { x: cursor.x, y: cursor.y },
                },
            );
        }
        log::info!(
            "walk_hover_ancestry(electron, {}): widen_level={} → {} \"{}\" {:.0}x{:.0}",
            if go_up { "up" } else { "down" },
            widen, picked.role, picked.name, bounds.w, bounds.h
        );
        let app_bg = app.clone();
        let mut picked_for_crop = picked.clone();
        tauri::async_runtime::spawn(async move {
            capture_pick_crop(&app_bg, &mut picked_for_crop).await;
            let Some(cp) = picked_for_crop.crop_path.clone() else {
                return;
            };
            let list = {
                let state = app_bg.state::<PickSessionState>();
                let mut s = state.0.lock().unwrap();
                match s.selected.last_mut() {
                    Some(last)
                        if last.pid == picked_for_crop.pid
                            && rects_match(&last.bounds, &picked_for_crop.bounds) =>
                    {
                        last.crop_path = Some(cp);
                        Some(s.selected.clone())
                    }
                    _ => None,
                }
            };
            if let Some(list) = list {
                let dir = app_bg.state::<OutputDir>().inner().0.clone();
                if let Ok(js) = serde_json::to_string(&list) {
                    let _ = std::fs::write(dir.join("last-selection.json"), js);
                }
            }
        });
        return Ok(());
    }
    // Snapshot the anchor (prefer the committed selection so ↑/↓ work AFTER a
    // pick; else the live hover) + the nav stack, without holding the lock across
    // AX FFI.
    let (target_pid_opt, current, mut nav_stack, frozen_pid) = {
        let state = app.state::<PickSessionState>();
        let mut s = state.0.lock().unwrap();
        if !s.active {
            return Err("pick mode not active".into());
        }
        let current = s.selected.last().cloned().or_else(|| s.last_hover.clone());
        // If the panel's app is frozen, resume it for the live AX query below, then
        // re-freeze right after (kept brief so the panel doesn't close).
        let frozen = unfreeze_app(&mut s.freeze_pid);
        (s.target_pid, current, s.nav_stack.clone(), frozen)
    };
    let Some(current) = current else {
        if let Some(pid) = frozen_pid {
            let st = app.state::<PickSessionState>();
            freeze_app(&mut st.0.lock().unwrap().freeze_pid, pid);
        }
        return Err("no element to walk from".into());
    };
    let our_pid = std::process::id() as i32;

    let anchor_click = current.click;

    // Compute the navigation target via the AX tree (sync closure — the non-Send
    // AxElement handles never cross an await). Ported from the web Alt+Arrow flow:
    //   ↑ = next genuinely-larger ancestor (skips wrapper nodes; capped at window),
    //   ↓ = retrace the ↑ path if possible, else the first child.
    // Grow-to-row: ↑ first selects the whole sibling BAND (e.g. the toolbar row) when one
    // exists, only then the real parent. The band's bounds aren't a single AX node, so we
    // build its subtree synthetically from the members (set inside the closure).
    let mut band_tree: Option<vibe_extract_core::ax_macos::Node> = None;
    let computed: Result<PickedElement, String> = (|| {
        if !go_up {
            if let Some(prev) = nav_stack
                .last()
                .cloned()
                .filter(|p| rect_inside(&p.bounds, &current.bounds))
            {
                nav_stack.pop();
                Ok(prev)
            } else {
                nav_stack.clear();
                let el = reacquire_current(target_pid_opt, &current)
                    .ok_or("couldn't locate the current element in the AX tree")?;
                ax_first_child_of(&el, &current.bounds, our_pid, target_pid_opt)
            }
        } else {
            let el = reacquire_current(target_pid_opt, &current)
                .ok_or("couldn't locate the current element in the AX tree")?;
            // Sibling BAND (the row) before the real parent — selects "the whole header
            // toolbar row" in flat trees (WPS: tabs are direct AXWindow children).
            if let Some((band, kids)) =
                vibe_extract_core::ax_macos::sibling_band(&el, &current.bounds, PICK_AX_MAX_DEPTH)
            {
                band_tree = Some(vibe_extract_core::ax_macos::Node {
                    role: "AXGroup".into(),
                    subrole: None,
                    name: String::new(),
                    identifier: None,
                    value: None,
                    role_description: Some("group".into()),
                    bounds: Some(band),
                    bg: None,
                    state: Vec::new(),
                    min_value: None,
                    max_value: None,
                    truncated: false,
                    child_source: Some("AXSiblingBand".into()),
                    children: kids,
                });
                nav_stack.push(current.clone());
                return Ok(region_picked(band, &el));
            }
            let parent = ax_parent_of(&el, &current.bounds, our_pid)?;
            nav_stack.push(current.clone());
            Ok(parent)
        }
    })();
    // Capture the new element's AX subtree NOW, while the app is still UNFROZEN (we
    // re-freeze just below) — a SIGSTOP'd app can't answer AX. Synchronous AX FFI like
    // the walk above; best-effort, so a miss just leaves ax_tree = None (Problem 4).
    // Skipped for a band region (its tree is the synthetic `band_tree`) and for a
    // ↓-retrace (where `computed` already carries the stored element's tree).
    let new_ax_tree = if band_tree.is_some() {
        None
    } else {
        computed.as_ref().ok().and_then(|np| {
            if np.ax_tree.is_some() {
                return None; // ↓-retrace: keep the stored element's tree
            }
            let el = reacquire_current(target_pid_opt, np)?;
            let node = vibe_extract_core::ax_macos::walk_node(&el, PICK_AX_MAX_DEPTH);
            (vibe_extract_core::ax_macos::count_nodes(&node) <= PICK_AX_MAX_NODES).then_some(node)
        })
    };
    // Live AX query is done — re-freeze the app immediately (kept brief so the panel
    // doesn't close), regardless of whether navigation succeeded.
    if let Some(pid) = frozen_pid {
        let st = app.state::<PickSessionState>();
        freeze_app(&mut st.0.lock().unwrap().freeze_pid, pid);
    }
    let new_picked = computed?;

    let mut picked = new_picked;
    picked.click = anchor_click;
    if let Some(bt) = band_tree {
        picked.ax_tree = Some(bt); // synthetic toolbar-row group
    } else if picked.ax_tree.is_none() {
        picked.ax_tree = new_ax_tree; // fresh ↑/↓ target (↓-retrace keeps its own)
    }
    let cursor = vibe_extract_core::ax_macos::current_cursor();

    // INSTANT commit — move the selection + highlight NOW so ↑/↓ feel immediate.
    // The pixel crop is captured in the background below and back-filled, so the
    // keypress never blocks on the ~200ms screencapture (that was the lag).
    let list = {
        let state = app.state::<PickSessionState>();
        let mut s = state.0.lock().unwrap();
        if !s.active {
            return Err("pick mode not active".into());
        }
        s.selected.clear();
        s.selected.push(picked.clone());
        s.locked_pid = Some(picked.pid);
        s.last_hover = Some(picked.clone());
        s.nav_stack = nav_stack;
        // Freeze the hover task until the mouse actually moves, so it doesn't yank
        // the highlight off the element we just navigated to (web isScrollNavigating).
        s.nav_active = true;
        s.nav_anchor_cursor = Some(cursor);
        s.selected.clone()
    };
    persist_and_broadcast(&app, &list);
    if let Some(overlay) = app.get_webview_window("overlay") {
        let _ = overlay.emit(
            "overlay-hover",
            OverlayHoverPayload {
                bounds: Some(OverlayBounds {
                    x: picked.bounds.x,
                    y: picked.bounds.y,
                    w: picked.bounds.w,
                    h: picked.bounds.h,
                }),
                role: picked.role.clone(),
                name: picked.name.clone(),
                cursor: OverlayCursor { x: cursor.x, y: cursor.y },
            },
        );
    }
    log::info!(
        "walk_hover_ancestry({}): now {} \"{}\" {:.0}x{:.0}",
        if go_up { "up" } else { "down" },
        picked.role, picked.name, picked.bounds.w, picked.bounds.h
    );

    // Background: capture the element's pixels, then back-fill crop_path into the
    // selection IF it's still the same element (user hasn't navigated on). Never
    // blocks the keypress.
    let app_bg = app.clone();
    let mut picked_for_crop = picked.clone();
    tauri::async_runtime::spawn(async move {
        capture_pick_crop(&app_bg, &mut picked_for_crop).await;
        let Some(cp) = picked_for_crop.crop_path.clone() else {
            return;
        };
        let list = {
            let state = app_bg.state::<PickSessionState>();
            let mut s = state.0.lock().unwrap();
            match s.selected.last_mut() {
                Some(last)
                    if last.pid == picked_for_crop.pid
                        && rects_match(&last.bounds, &picked_for_crop.bounds) =>
                {
                    last.crop_path = Some(cp);
                    Some(s.selected.clone())
                }
                _ => None,
            }
        };
        if let Some(list) = list {
            // Re-persist last-selection.json so `get_selection` now carries the crop.
            let dir = app_bg.state::<OutputDir>().inner().0.clone();
            if let Ok(js) = serde_json::to_string(&list) {
                let _ = std::fs::write(dir.join("last-selection.json"), js);
            }
        }
    });
    Ok(())
}

/// True when `inner` lies within `outer` AND is strictly smaller in some dimension
/// (so a child genuinely descends). Used by ↓ to decide retrace vs first-child.
fn rect_inside(
    inner: &vibe_extract_core::capture::ScreenRect,
    outer: &vibe_extract_core::capture::ScreenRect,
) -> bool {
    inner.x >= outer.x - 1.0
        && inner.y >= outer.y - 1.0
        && inner.x + inner.w <= outer.x + outer.w + 1.0
        && inner.y + inner.h <= outer.y + outer.h + 1.0
        && (inner.w < outer.w - 0.5 || inner.h < outer.h - 0.5)
}

/// Two rects are ~equal (within 2pt on every edge) — used to recognise the element
/// we're currently ON among the ancestors of a centre hit-test.
fn rects_match(
    a: &vibe_extract_core::capture::ScreenRect,
    b: &vibe_extract_core::capture::ScreenRect,
) -> bool {
    (a.x - b.x).abs() <= 2.0
        && (a.y - b.y).abs() <= 2.0
        && (a.w - b.w).abs() <= 2.0
        && (a.h - b.h).abs() <= 2.0
}

/// Build a PickedElement from an AX element reached by tree navigation.
#[cfg(target_os = "macos")]
fn picked_from(
    el: &vibe_extract_core::ax_macos::AxElement,
    bounds: vibe_extract_core::capture::ScreenRect,
) -> PickedElement {
    let name = el
        .str_attr("AXTitle")
        .or_else(|| el.str_attr("AXDescription"))
        .or_else(|| el.str_attr("AXLabel"))
        .or_else(|| el.str_attr("AXValue"))
        .unwrap_or_default();
    let pid = el.pid().unwrap_or(-1);
    PickedElement {
        role: el.str_attr("AXRole").unwrap_or_default(),
        subrole: el.str_attr("AXSubrole").filter(|s| !s.is_empty()),
        name,
        identifier: el.str_attr("AXIdentifier").filter(|s| !s.is_empty()),
        bounds,
        pid,
        app_path: vibe_extract_core::ax_macos::pid_to_path(pid),
        window_title: None,
        window_bounds: el.enclosing_window().and_then(|w| w.rect()),
        click: None,
        ax_shallow: false,
        crop_path: None,
        ax_tree: None,
    }
}

/// Build a synthetic "region" PickedElement (e.g. a whole toolbar ROW) covering `bounds`.
/// This isn't a single AX node, so role is `AXGroup` and `ax_shallow` is false (the bounds
/// are real). Used by ↑ grow-to-row; its `ax_tree` is filled in by the caller from the
/// band members. `el` supplies the owning pid + enclosing window.
#[cfg(target_os = "macos")]
fn region_picked(
    bounds: vibe_extract_core::capture::ScreenRect,
    el: &vibe_extract_core::ax_macos::AxElement,
) -> PickedElement {
    let pid = el.pid().unwrap_or(-1);
    PickedElement {
        role: "AXGroup".into(),
        subrole: None,
        name: String::new(),
        identifier: None,
        bounds,
        pid,
        app_path: vibe_extract_core::ax_macos::pid_to_path(pid),
        window_title: None,
        window_bounds: el.enclosing_window().and_then(|w| w.rect()),
        click: None,
        ax_shallow: false,
        crop_path: None,
        ax_tree: None,
    }
}

/// Re-acquire the AX handle for the element we're currently ON. A centre hit-test
/// returns the DEEPEST element at that point — NOT necessarily `current` (which may
/// be a container we walked up to). So climb the hit element's ancestors until one's
/// bounds match `current`: THAT is the node to navigate from. (Fixes level-jumping —
/// previously we walked from the deepest leaf.)
#[cfg(target_os = "macos")]
fn reacquire_current(
    target_pid: Option<i32>,
    current: &PickedElement,
) -> Option<vibe_extract_core::ax_macos::AxElement> {
    let center = current.bounds.center();
    let hit = |c| {
        if let Some(pid) = target_pid {
            vibe_extract_core::ax_macos::element_at_in_app(c, pid)
        } else {
            vibe_extract_core::ax_macos::element_at(c)
        }
    };
    let mut el = hit(center)?;
    for _ in 0..48 {
        if matches!(el.rect(), Some(b) if rects_match(&b, &current.bounds)) {
            return Some(el);
        }
        match el.parent() {
            Some(p) => el = p,
            None => break,
        }
    }
    hit(center) // fallback: the deepest element at the centre
}

/// Step UP from the element we're on to the next genuinely-larger ancestor —
/// skipping bounds-less / same-size WRAPPER nodes (AX noise) so each ↑ is one
/// VISIBLE level — and treat the AXWindow as the top (whole window = the max).
#[cfg(target_os = "macos")]
fn ax_parent_of(
    cur_el: &vibe_extract_core::ax_macos::AxElement,
    current_bounds: &vibe_extract_core::capture::ScreenRect,
    our_pid: i32,
) -> Result<PickedElement, String> {
    if cur_el.str_attr("AXRole").as_deref() == Some("AXWindow") {
        return Err("already at the window (max)".into());
    }
    let mut p = cur_el.parent().ok_or("already at the top — can't go higher")?;
    for _ in 0..48 {
        let role = p.str_attr("AXRole").unwrap_or_default();
        let pid = p.pid().unwrap_or(-1);
        if pid == our_pid || role == "AXApplication" {
            return Err("reached the application root".into());
        }
        if let Some(b) = p.rect() {
            if b.w >= 1.0 && b.h >= 1.0 {
                // A meaningful step up = strictly larger than current, OR the window.
                if rect_inside(current_bounds, &b) || role == "AXWindow" {
                    return Ok(picked_from(&p, b));
                }
            }
        }
        if role == "AXWindow" {
            return Err("window has no usable bounds".into());
        }
        match p.parent() {
            Some(pp) => p = pp,
            None => return Err("reached the top".into()),
        }
    }
    Err("no larger ancestor found".into())
}

/// First MEANINGFUL child of the element we're on (usable bounds, in the target
/// app, strictly inside) — mouse-free, mirroring the web getFirstElementChild.
#[cfg(target_os = "macos")]
fn ax_first_child_of(
    cur_el: &vibe_extract_core::ax_macos::AxElement,
    current_bounds: &vibe_extract_core::capture::ScreenRect,
    our_pid: i32,
    target_pid: Option<i32>,
) -> Result<PickedElement, String> {
    for child in cur_el.array_attr("AXChildren") {
        let Some(b) = child.rect() else { continue };
        if b.w < 1.0 || b.h < 1.0 {
            continue;
        }
        let pid = child.pid().unwrap_or(-1);
        if pid == our_pid || (target_pid.is_some() && Some(pid) != target_pid) {
            continue;
        }
        if !rect_inside(&b, current_bounds) {
            continue;
        }
        return Ok(picked_from(&child, b));
    }
    Err("no child to descend into".into())
}

#[cfg(not(target_os = "macos"))]
async fn walk_hover_ancestry(_app: AppHandle, _go_up: bool) -> Result<(), String> {
    Err("walk_hover_ancestry only implemented on macOS".into())
}

/// Build version, shown in the UI header so it's obvious which build is running.
#[tauri::command]
fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[tauri::command]
async fn save_to_disk(name: String, contents: String) -> Result<String, String> {
    use std::io::Write;
    let dir = dirs_home().join("Documents").join("Echo Captures");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(&name);
    let mut f = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    f.write_all(contents.as_bytes()).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

// =============================================================================
// Hover-tracking task
// =============================================================================

fn spawn_hover_task(app: AppHandle) {
    let state = app.state::<PickSessionState>().inner().0.clone();
    let our_pid: i32 = std::process::id() as i32;
    tauri::async_runtime::spawn(async move {
        // Throttle state for the Electron CDP-hover probe (persists across ticks):
        // the last (cursor x, y, widen_level) we probed.
        let mut last_probe: Option<(f64, f64, u32)> = None;
        loop {
            // Tick at ~30Hz.
            tokio::time::sleep(std::time::Duration::from_millis(33)).await;
            let still_active = state.lock().unwrap().active;
            if !still_active {
                break;
            }
            // Read live cursor and AX-hit-test.
            #[cfg(target_os = "macos")]
            {
                let pt = vibe_extract_core::ax_macos::current_cursor();
                if pt.x < 0.0 || pt.y < 0.0 {
                    continue;
                }

                // --- Frozen-app guard (WPS PDF etc.) ---------------------------
                // While a picked app is SIGSTOP-frozen (so its hover panel stays
                // open), skip hover tracking: a suspended app can't answer AX (the
                // call would hang), and the committed selection stays outlined. The
                // cursor still moves freely. Released on Esc/clear/stop.
                if state.lock().unwrap().freeze_pid.is_some() {
                    continue;
                }

                // --- Keyboard-nav freeze (web `isScrollNavigating`) -------------
                // While the user is walking the tree via ↑/↓ and HASN'T moved the
                // mouse, don't let the hover re-target — keep the navigated element
                // highlighted/selected. The first real cursor move ends nav.
                {
                    let mut s = state.lock().unwrap();
                    if s.nav_active {
                        let moved = match s.nav_anchor_cursor {
                            Some(a) => (pt.x - a.x).abs() > 4.0 || (pt.y - a.y).abs() > 4.0,
                            None => true,
                        };
                        if moved {
                            s.nav_active = false;
                            s.nav_anchor_cursor = None;
                            s.nav_stack.clear();
                        } else {
                            continue; // frozen — leave the navigated selection showing
                        }
                    }
                }

                // --- Electron: drive the highlight from the live DOM (CDP) ------
                // When the target is an Electron app with a debug port, its real
                // UI isn't in the AX tree — so probe the DOM at the cursor and
                // outline the REAL element the user is over (with `widen_level`
                // extra parent steps from ↑/↓). This makes the highlight truthful;
                // clicking then commits exactly what's outlined. Skips the AX path.
                let (cdp_port, target_win, widen_level, tpid) = {
                    let s = state.lock().unwrap();
                    (s.cdp_port, s.target_win, s.widen_level, s.target_pid)
                };
                if let (Some(port), Some(win)) = (cdp_port, target_win) {
                    let moved = match last_probe {
                        Some((lx, ly, lw)) => {
                            (pt.x - lx).abs() > 3.0 || (pt.y - ly).abs() > 3.0 || lw != widen_level
                        }
                        None => true,
                    };
                    if moved {
                        last_probe = Some((pt.x, pt.y, widen_level));
                        let vx = pt.x - win.x;
                        let vy = pt.y - win.y;
                        if vx >= 0.0 && vy >= 0.0 && vx <= win.w && vy <= win.h {
                            match vibe_extract_core::cdp::probe_at(port, 0, vx, vy, widen_level).await
                            {
                                Ok(Some(hit)) => {
                                    let bounds = vibe_extract_core::capture::ScreenRect {
                                        x: hit.x + win.x,
                                        y: hit.y + win.y,
                                        w: hit.w,
                                        h: hit.h,
                                    };
                                    let label = if hit.label.is_empty() {
                                        hit.tag.clone()
                                    } else {
                                        hit.label.clone()
                                    };
                                    let role = if hit.role.is_empty() {
                                        format!("dom:{}", hit.tag)
                                    } else {
                                        hit.role.clone()
                                    };
                                    state.lock().unwrap().last_hover = Some(PickedElement {
                                        role: role.clone(),
                                        subrole: None,
                                        name: label.clone(),
                                        identifier: None,
                                        bounds,
                                        pid: tpid.unwrap_or(-1),
                                        app_path: tpid
                                            .and_then(vibe_extract_core::ax_macos::pid_to_path),
                                        window_title: None,
                                        window_bounds: Some(win),
                                        click: Some(pt),
                                        ax_shallow: false,
                                        crop_path: None,
                                        ax_tree: None,
                                    });
                                    if let Some(overlay) = app.get_webview_window("overlay") {
                                        let _ = overlay.emit(
                                            "overlay-hover",
                                            OverlayHoverPayload {
                                                bounds: Some(OverlayBounds {
                                                    x: bounds.x,
                                                    y: bounds.y,
                                                    w: bounds.w,
                                                    h: bounds.h,
                                                }),
                                                role,
                                                name: label,
                                                cursor: OverlayCursor { x: pt.x, y: pt.y },
                                            },
                                        );
                                    }
                                }
                                _ => {
                                    // No DOM element under the point (or probe failed) —
                                    // CLEAR the outline (don't leave a stale box painted
                                    // once the cursor leaves the content) + move cursor.
                                    state.lock().unwrap().last_hover = None;
                                    if let Some(overlay) = app.get_webview_window("overlay") {
                                        let _ = overlay.emit(
                                            "overlay-hover",
                                            OverlayHoverPayload {
                                                bounds: None,
                                                role: String::new(),
                                                name: String::new(),
                                                cursor: OverlayCursor { x: pt.x, y: pt.y },
                                            },
                                        );
                                    }
                                }
                            }
                        } else {
                            // Cursor is OUTSIDE the target window — clear any stale
                            // outline so it doesn't bleed over another app or desktop.
                            state.lock().unwrap().last_hover = None;
                            if let Some(overlay) = app.get_webview_window("overlay") {
                                let _ = overlay.emit(
                                    "overlay-hover",
                                    OverlayHoverPayload {
                                        bounds: None,
                                        role: String::new(),
                                        name: String::new(),
                                        cursor: OverlayCursor { x: pt.x, y: pt.y },
                                    },
                                );
                            }
                        }
                    }
                    continue;
                }

                // Get target pid (the app the user was on when they pressed ⌘⇧S).
                let target_pid_opt = { state.lock().unwrap().target_pid };
                // First pass — synchronous block so AxElement (non-Send) drops
                // before any await. Hit-test against the TARGET app's AX tree
                // (not the system-wide root), which avoids Electron-helper
                // pid issues entirely.
                let (initial_payload, pid_to_wake): (Option<OverlayHoverPayload>, Option<i32>) = {
                    let hit_result = match target_pid_opt {
                        Some(pid) => vibe_extract_core::ax_macos::element_at_in_app(pt, pid),
                        None => vibe_extract_core::ax_macos::element_at_excluding(pt, our_pid),
                    };
                    // Apple's AXUIElementCopyElementAtPosition is a GLOBAL hit-test:
                    // even though we passed `AXUIElementCreateApplication(target_pid)`,
                    // if the cursor is over a foreign app's window (e.g. our own
                    // overlay) it can return that foreign-process element. Reject
                    // when the pid doesn't match the target.
                    //
                    // We DELIBERATELY ACCEPT AXMenuBar/AXApplication results even
                    // mid-screen. Slack's Electron AX tree is so shallow that
                    // Apple often returns these as the only valid hit. Rejecting
                    // them leaves `last_hover` empty and every subsequent click
                    // fails. Accepting means the dispatcher runs its full ladder
                    // (CDP → AX walk → screenshot fallback) — at worst the user
                    // gets a captured screenshot with a clear "AX too shallow"
                    // banner, which is FAR better than silent failure.
                    let hit_result = hit_result.and_then(|el| {
                        let elem_pid = el.pid().unwrap_or(-1);
                        match target_pid_opt {
                            Some(want) if elem_pid != want => {
                                log::warn!(
                                    "hover: discarded foreign-pid hit — target_pid={} got pid={} role={:?}",
                                    want, elem_pid, el.str_attr("AXRole")
                                );
                                return None;
                            }
                            _ if elem_pid == our_pid => {
                                log::warn!(
                                    "hover: discarded self-pid hit — pid={} (our own process)",
                                    elem_pid
                                );
                                return None;
                            }
                            _ => {}
                        }
                        Some(el)
                    });
                    match hit_result {
                        Some(initial) => {
                            let el = vibe_extract_core::ax_macos::deepen_at(initial, pt);
                            let pid = el.pid().unwrap_or(-1);
                            let role = el.str_attr("AXRole").unwrap_or_default();
                            let subrole = el.str_attr("AXSubrole").filter(|s| !s.is_empty());
                            let name = el
                                .str_attr("AXTitle")
                                .or_else(|| el.str_attr("AXDescription"))
                                .or_else(|| el.str_attr("AXLabel"))
                                .or_else(|| el.str_attr("AXValue"))
                                .unwrap_or_default();
                            let identifier = el.str_attr("AXIdentifier").filter(|s| !s.is_empty());
                            let bounds = el.rect();
                            // Resolve app_path + enclosing-window info so the
                            // dispatcher can detect Electron and run the CDP
                            // path. Without these, framework=Unknown and we
                            // silently fall through to AX — exactly the bug
                            // that left Slack captures as empty boxes.
                            let app_path = vibe_extract_core::ax_macos::pid_to_path(pid);
                            let (window_bounds, window_title) = match el.enclosing_window() {
                                Some(win) => (win.rect(), win.str_attr("AXTitle")),
                                None => (None, None),
                            };
                            let (needs_wake, _) = {
                                let mut s = state.lock().unwrap();
                                let needs = if pid > 0 && !s.woken_pids.contains(&pid) {
                                    s.woken_pids.insert(pid);
                                    true
                                } else {
                                    false
                                };
                                // Stash a PickedElement so click can use exactly
                                // what's outlined — no race between hover and click.
                                if let Some(b) = bounds {
                                    let ax_shallow = vibe_extract_core::ax_macos::is_shallow_pick(
                                        &role,
                                        &b,
                                        pt,
                                        window_bounds.as_ref(),
                                        el.child_count(),
                                    );
                                    s.last_hover = Some(PickedElement {
                                        role: role.clone(),
                                        subrole: subrole.clone(),
                                        name: name.clone(),
                                        identifier: identifier.clone(),
                                        bounds: b,
                                        pid,
                                        app_path,
                                        window_title,
                                        window_bounds,
                                        click: Some(pt),
                                        ax_shallow,
                                        crop_path: None,
                                        ax_tree: None,
                                    });
                                }
                                (needs, ())
                            };
                            let payload = OverlayHoverPayload {
                                bounds: bounds.map(|b| OverlayBounds {
                                    x: b.x,
                                    y: b.y,
                                    w: b.w,
                                    h: b.h,
                                }),
                                role,
                                name,
                                cursor: OverlayCursor { x: pt.x, y: pt.y },
                            };
                            (Some(payload), if needs_wake { Some(pid) } else { None })
                        }
                        None => {
                            // No valid AX element under cursor — clear the stale
                            // cache so a later click doesn't commit something from
                            // a previous tick (e.g. a menu bar we already filtered
                            // out, but that had been cached on an earlier tick).
                            {
                                let mut s = state.lock().unwrap();
                                s.last_hover = None;
                            }
                            // Send cursor so the crosshair still follows the mouse.
                            let cursor_only = OverlayHoverPayload {
                                bounds: None,
                                role: String::new(),
                                name: String::new(),
                                cursor: OverlayCursor { x: pt.x, y: pt.y },
                            };
                            (Some(cursor_only), None)
                        }
                    }
                };

                // If we needed to wake a new pid, do that + a tiny sleep, then
                // re-query in another sync block.
                let final_payload = if let Some(pid) = pid_to_wake {
                    vibe_extract_core::ax_macos::wake_app_ax(pid);
                    tokio::time::sleep(std::time::Duration::from_millis(60)).await;
                    let pt2 = vibe_extract_core::ax_macos::current_cursor();
                    let target_pid_opt2 = { state.lock().unwrap().target_pid };
                    let hit_result2 = match target_pid_opt2 {
                        Some(p) => vibe_extract_core::ax_macos::element_at_in_app(pt2, p),
                        None => vibe_extract_core::ax_macos::element_at_excluding(pt2, our_pid),
                    };
                    // Same pid filter as the first-pass hit-test above. We
                    // intentionally accept AXMenuBar/AXApplication so the
                    // dispatcher can do its best with whatever Slack gave us.
                    let hit_result2 = hit_result2.and_then(|el| {
                        let elem_pid = el.pid().unwrap_or(-1);
                        match target_pid_opt2 {
                            Some(want) if elem_pid != want => None,
                            _ if elem_pid == our_pid => None,
                            _ => Some(el),
                        }
                    });
                    let payload_after = {
                        match hit_result2 {
                            Some(initial) => {
                                let el = vibe_extract_core::ax_macos::deepen_at(initial, pt2);
                                let role = el.str_attr("AXRole").unwrap_or_default();
                                let name = el
                                    .str_attr("AXTitle")
                                    .or_else(|| el.str_attr("AXDescription"))
                                    .or_else(|| el.str_attr("AXLabel"))
                                    .unwrap_or_default();
                                let bounds = el.rect();
                                Some(OverlayHoverPayload {
                                    bounds: bounds.map(|b| OverlayBounds {
                                        x: b.x,
                                        y: b.y,
                                        w: b.w,
                                        h: b.h,
                                    }),
                                    role,
                                    name,
                                    cursor: OverlayCursor { x: pt2.x, y: pt2.y },
                                })
                            }
                            None => None,
                        }
                    };
                    payload_after.or(initial_payload)
                } else {
                    initial_payload
                };

                if let Some(payload) = final_payload {
                    if let Some(overlay) = app.get_webview_window("overlay") {
                        let _ = overlay.emit("overlay-hover", payload);
                    }
                }
            }
        }
        log::info!("hover task exited (pick mode off)");
    });
}

// =============================================================================
// App entry
// =============================================================================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::new()
        .filter_level(log::LevelFilter::Info)
        .format_timestamp(None)
        .init();

    // Safety net: if VibeExtract panics on ANY thread while a target app is SIGSTOP-
    // frozen, resume it so we never leave a user's app stuck. Reads ONLY the lock-free
    // FROZEN_PID (no Tauri state / no mutex — a poisoned PickSession lock here would
    // otherwise deadlock or re-panic). Chains the previous hook.
    {
        let prev = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let pid = FROZEN_PID.swap(0, std::sync::atomic::Ordering::SeqCst);
            if pid > 0 {
                #[cfg(target_os = "macos")]
                vibe_extract_core::app_freeze_macos::resume(pid);
            }
            prev(info);
        }));
    }

    let output_dir = find_output_dir();
    log::info!(
        "contentScript.js: embedded at compile time ({} bytes)",
        CONTENT_SCRIPT.len()
    );
    log::info!("output dir: {}", output_dir.display());

    tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state != ShortcutState::Pressed {
                        return;
                    }
                    let combo = shortcut.into_string();
                    log::info!("hotkey fired: {}", combo);
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        if combo.contains("KeyS") {
                            // ⌘⇧S has ONE semantic: arm a fresh selection on
                            // the current target app. No toggle-off behaviour
                            // — that's what Esc is for. If pick mode is
                            // already active (e.g. after a post-export soft
                            // reset), tear it down silently first, then start
                            // fresh. The atomic `starting` flag prevents
                            // rapid double-presses from racing.
                            let (was_active, claimed_starting) = {
                                let Some(s) = app.try_state::<PickSessionState>() else {
                                    return;
                                };
                                let mut g = s.0.lock().unwrap();
                                if g.starting {
                                    // Another start is in flight — ignore.
                                    (false, false)
                                } else {
                                    g.starting = true;
                                    (g.active, true)
                                }
                            };
                            if !claimed_starting {
                                log::debug!("⌘⇧S ignored — start already in progress");
                            } else {
                                if was_active {
                                    // Silently tear down the stale session
                                    // without raising the main window — the
                                    // user wants pick mode on, not the main
                                    // window forward.
                                    log::info!("⌘⇧S: stopping stale pick mode before fresh arm");
                                    let _ = stop_pick_mode(app.clone()).await;
                                }
                                let result = start_pick_mode(app.clone()).await;
                                if let Some(s) = app.try_state::<PickSessionState>() {
                                    s.0.lock().unwrap().starting = false;
                                }
                                if let Err(e) = result {
                                    log::warn!("start_pick_mode failed: {}", e);
                                }
                            }
                        } else if combo.contains("KeyE") {
                            // Snapshot session state + claim the `starting`
                            // slot atomically so a rapid double ⌘⇧E doesn't
                            // race two auto-starts.
                            let (was_active, has_selection, claimed_starting) = {
                                let Some(s) = app.try_state::<PickSessionState>() else {
                                    return;
                                };
                                let mut g = s.0.lock().unwrap();
                                let active = g.active;
                                let has_sel = !g.selected.is_empty();
                                let want_start = !active && !has_sel && !g.starting;
                                if want_start {
                                    g.starting = true;
                                }
                                (active, has_sel, want_start)
                            };

                            // SAFETY NET: if pick mode is off AND there's no
                            // selection to export, ⌘⇧E acts as ⌘⇧S — starts a
                            // pick session. This makes the app work even if
                            // ⌘⇧S is shadowed by another app's shortcut
                            // (common with Bartender, Magnet, Rectangle, or
                            // macOS Accessibility settings that bind ⌘⇧S).
                            // The user can then click an element and press
                            // ⌘⇧E again to actually export.
                            if claimed_starting {
                                log::info!(
                                    "⌘⇧E with no pick mode and no selection — auto-starting pick mode"
                                );
                                let result = start_pick_mode(app.clone()).await;
                                // Always clear `starting` so a future failed
                                // start doesn't permanently lock us out.
                                if let Some(s) = app.try_state::<PickSessionState>() {
                                    s.0.lock().unwrap().starting = false;
                                }
                                match result {
                                    Ok(()) => {
                                        let _ = app.emit(
                                            "toast",
                                            "Pick mode armed — click an element, then press ⌘⇧E again to capture.",
                                        );
                                    }
                                    Err(e) => {
                                        log::warn!("auto start_pick_mode failed: {}", e);
                                        let _ = app.emit(
                                            "toast",
                                            format!(
                                                "Couldn't start pick mode: {} — click on the target app first, then retry.",
                                                e
                                            ),
                                        );
                                    }
                                }
                                return; // exit this turn — user needs to click + press ⌘⇧E again
                            }
                            if !was_active && !has_selection {
                                // Another auto-start is already in flight.
                                // Tell the user to wait instead of silently
                                // dropping the keypress.
                                let _ = app.emit(
                                    "toast",
                                    "Pick mode is already starting — give it a moment, then click.",
                                );
                                return;
                            }

                            match export_selection(app.clone()).await {
                                Ok(payload) => {
                                    let _ = app.emit("export-result", payload);
                                    // ALWAYS raise the main window after a
                                    // successful capture — symmetric with
                                    // Esc. The user explicitly pressed ⌘⇧E
                                    // to capture, so they expect to see what
                                    // they got. Pick mode stays armed
                                    // (overlay + event tap still installed)
                                    // so they can ⌘+Tab back and pick again.
                                    raise_main_window(&app);
                                    if was_active {
                                        let _ = app.emit(
                                            "toast",
                                            "✓ Captured — pick mode is still on; click again or press Esc to end",
                                        );
                                    }
                                }
                                Err(e) => {
                                    log::warn!("export failed: {}", e);
                                    // Clear the stale result so the user
                                    // doesn't see the previous capture as if
                                    // it were the new one.
                                    let _ = app.emit("export-cleared", ());
                                    let hint = if was_active {
                                        "Hover over an element first, then click before pressing ⌘⇧E."
                                    } else {
                                        "Press ⌘⇧E again to start picking, click an element, then ⌘⇧E to capture."
                                    };
                                    let _ = app.emit(
                                        "toast",
                                        format!("Export failed: {} — {}", e, hint),
                                    );
                                    if !was_active {
                                        raise_main_window(&app);
                                    }
                                }
                            }
                        } else if combo.contains("KeyX") {
                            match extract_frontmost_window_cmd(app.clone()).await {
                                Ok(payload) => {
                                    let _ = app.emit("export-result", payload);
                                    raise_main_window(&app);
                                }
                                Err(e) => {
                                    log::warn!("extract whole window failed: {}", e);
                                    let _ = app.emit("toast", format!("Failed: {}", e));
                                    raise_main_window(&app);
                                }
                            }
                        } else if combo.contains("Escape") {
                            // Esc is only registered while pick mode is active.
                            // Tear down the session AND raise the main window
                            // so the user immediately sees the latest captured
                            // result instead of staring at their target app.
                            let _ = stop_pick_mode(app.clone()).await;
                            raise_main_window(&app);
                        } else if combo.contains("Enter") {
                            // Enter LOCKS the current selection: resume the frozen
                            // target, exit pick mode, and surface the captured result.
                            let _ = commit_selection(app.clone()).await;
                        } else if combo.contains("ArrowUp")
                            || combo.contains("ArrowDown")
                        {
                            // Parent / child walk during pick mode. Updates
                            // `last_hover` to the new element so the next click
                            // (or the current outline) reflects the broader
                            // ancestor (Up) or the deeper child (Down).
                            let go_up = combo.contains("ArrowUp");
                            if let Err(e) = walk_hover_ancestry(app.clone(), go_up).await {
                                // Surface WHY the walk didn't move (top of tree, AX
                                // re-acquire miss, …) — a silent no-op reads as a
                                // dead key.
                                log::info!("walk_hover_ancestry: {}", e);
                                let _ = app.emit("toast", format!("{} {}", if go_up { "↑" } else { "↓" }, e));
                            }
                        }
                    });
                })
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .manage(OutputDir(output_dir))
        .manage(PickSessionState::default())
        .manage(LastForeignAppState::default())
        .manage(EventTapState::default())
        .manage(RegisteredHotkeys::default())
        .manage(RelaunchDialogState::default())
        .manage(RelaunchInProgressState::default())
        .manage(ExportInProgressState::default())
        .manage(mcp::McpServerState::default())
        .invoke_handler(tauri::generate_handler![
            app_version,
            check_ax_permission,
            request_ax_permission,
            start_pick_mode,
            stop_pick_mode,
            commit_selection,
            overlay_click,
            export_selection,
            extract_frontmost_window_cmd,
            save_to_disk,
            output_dir_info,
            reveal_output_dir,
            get_relaunch_dialog_info,
            relaunch_dialog_response,
            get_settings_cmd,
            set_electron_pref_cmd,
            known_electron_apps,
            mcp::mcp_status,
            mcp::mcp_toggle,
            install_replicate_ui_skill,
        ])
        .setup(|app| {
            // Freeze-recovery: point the on-disk record at the output dir, then resume
            // any app a previous (SIGKILLed) VibeExtract left frozen. Do this FIRST,
            // before anything can arm a new freeze.
            {
                let dir = app.state::<OutputDir>().inner().0.clone();
                let _ = FROZEN_PID_FILE.set(dir.join("frozen-pid"));
                resume_orphaned_freeze_on_launch();
            }

            // Watchdog: force-resume an ORPHANED freeze — `freeze_pid` set while NO pick
            // session is active (`!active`), which should never persist. It deliberately
            // does NOT fire during refinement (active==true), so a user pausing mid-refine
            // is never interrupted. ~1s cadence, ~2s grace.
            {
                let h = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let mut orphan_since: Option<std::time::Instant> = None;
                    loop {
                        tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
                        let Some(state) = h.try_state::<PickSessionState>() else { continue };
                        let stuck = {
                            let s = state.0.lock().unwrap();
                            s.freeze_pid.is_some() && !s.active
                        };
                        if !stuck {
                            orphan_since = None;
                            continue;
                        }
                        match orphan_since {
                            None => orphan_since = Some(std::time::Instant::now()),
                            Some(t) if t.elapsed() >= std::time::Duration::from_secs(2) => {
                                let mut s = state.0.lock().unwrap();
                                if s.freeze_pid.is_some() && !s.active {
                                    log::warn!(
                                        "freeze watchdog: force-resuming orphaned pid {:?}",
                                        s.freeze_pid
                                    );
                                    unfreeze_app(&mut s.freeze_pid);
                                }
                                orphan_since = None;
                            }
                            _ => {}
                        }
                    }
                });
            }

            // Three hotkeys: Cmd+Shift+S / E / X.
            #[cfg(target_os = "macos")]
            let mods = Modifiers::SUPER | Modifiers::SHIFT;
            #[cfg(not(target_os = "macos"))]
            let mods = Modifiers::CONTROL | Modifiers::SHIFT;

            let combos = [
                Shortcut::new(Some(mods), Code::KeyS),
                Shortcut::new(Some(mods), Code::KeyE),
                Shortcut::new(Some(mods), Code::KeyX),
            ];

            let mut registered = Vec::new();
            for s in combos.iter() {
                match app.global_shortcut().register(s.clone()) {
                    Ok(_) => {
                        log::info!("registered {:?}", s);
                        registered.push(s.clone());
                    }
                    Err(e) => log::warn!("register {:?}: {}", s, e),
                }
            }
            if let Some(state) = app.try_state::<RegisteredHotkeys>() {
                *state.0.lock().unwrap() = registered;
            }

            // Hide the overlay window on startup (it's defined as `visible: false`
            // already, but resize it now to the primary monitor too).
            if let Some(overlay) = app.get_webview_window("overlay") {
                let _ = overlay.set_ignore_cursor_events(true);
                if let Some(monitor) = overlay.primary_monitor().ok().flatten() {
                    let _ = overlay.set_position(tauri::PhysicalPosition {
                        x: monitor.position().x,
                        y: monitor.position().y,
                    });
                    let _ = overlay.set_size(tauri::PhysicalSize {
                        width: monitor.size().width,
                        height: monitor.size().height,
                    });
                }
                // Configure once at startup so the overlay can appear over
                // full-screen apps. Tauri's `set_visible_on_all_workspaces`
                // covers spaces; our objc helper adds FullScreenAuxiliary
                // and bumps the window level.
                #[cfg(target_os = "macos")]
                make_overlay_fullscreen_compatible(&overlay);
                let _ = overlay.set_visible_on_all_workspaces(true);
            }

            // Background poller that always knows the last non-VibeExtract
            // frontmost app. This is what we use as target when the user
            // presses ⌘⇧S while focused on us.
            let app_clone = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let our_pid = std::process::id() as i32;
                // Tracks whether we've cleared the overlay because the target app isn't
                // frontmost, so we only emit on transitions (not every tick).
                let mut overlay_suppressed = false;
                loop {
                    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                    #[cfg(target_os = "macos")]
                    {
                        let front = frontmost_app_pid_via_nsworkspace();
                        if let Some(pid) = front {
                            if pid != our_pid && pid > 0 {
                                if let Some(state) =
                                    app_clone.try_state::<LastForeignAppState>()
                                {
                                    let mut g = state.0.lock().unwrap();
                                    if g.as_ref() != Some(&pid) {
                                        log::debug!("last_foreign_app updated: {} ({:?})", pid, app_name_for_pid(pid));
                                    }
                                    *g = Some(pid);
                                }
                            }
                        }
                        // Overlay-bleed guard (Problem 3): while picking, only PAINT the
                        // outlines when the locked/target app is frontmost. When the user
                        // switches to another app or Space, clear them so they don't bleed
                        // over it; restore (re-emit the committed outlines) when it returns.
                        if let Some(ps) = app_clone.try_state::<PickSessionState>() {
                            let (active, want, frozen) = {
                                let s = ps.0.lock().unwrap();
                                (s.active, s.locked_pid.or(s.target_pid), s.freeze_pid.is_some())
                            };
                            if active {
                                let on_target =
                                    matches!((front, want), (Some(f), Some(w)) if f == w);
                                if !on_target && !overlay_suppressed {
                                    overlay_suppressed = true;
                                    if let Some(overlay) = app_clone.get_webview_window("overlay") {
                                        let _ = overlay.emit("overlay-suppress", ());
                                    }
                                } else if on_target && overlay_suppressed {
                                    overlay_suppressed = false;
                                    let selection = { ps.0.lock().unwrap().selected.clone() };
                                    persist_and_broadcast(&app_clone, &selection);
                                    // Re-show the refine banner if the target is still frozen.
                                    if frozen {
                                        if let Some(overlay) =
                                            app_clone.get_webview_window("overlay")
                                        {
                                            let _ = overlay.emit("overlay-status", REFINE_BANNER);
                                        }
                                    }
                                }
                            } else if overlay_suppressed {
                                overlay_suppressed = false; // reset when pick mode ends
                            }
                        }
                    }
                }
            });

            // Auto-start the MCP server on launch — DEFAULT ON so installed users
            // (office devs) don't have to toggle anything or set an env var: open the
            // app, grant permissions once, and `/replicate-ui` can connect to
            // 127.0.0.1:8765 immediately. Opt OUT with VIBE_MCP_NO_AUTOSTART=1 (for
            // devs who want to start it manually from the UI). The legacy
            // VIBE_MCP_AUTOSTART=1 still works as an explicit opt-IN and overrides the
            // opt-out, so existing scripts keep behaving.
            let opt_out = std::env::var_os("VIBE_MCP_NO_AUTOSTART").is_some();
            let force_on = std::env::var_os("VIBE_MCP_AUTOSTART").is_some();
            let do_mcp = force_on || !opt_out;
            {
                let h = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let url = if do_mcp {
                        match mcp::start(h.clone()).await {
                            Ok(s) => {
                                log::info!("MCP auto-started: {:?}", s.url);
                                s.url
                            }
                            Err(e) => {
                                log::error!("MCP auto-start failed: {e}");
                                None
                            }
                        }
                    } else {
                        None
                    };
                    // Self-install the /replicate-ui skill + register MCP (idempotent).
                    match setup_claude_integration(&h, url) {
                        Ok(r) => log::info!(
                            "claude integration (skill={}, mcp={}): {:?}",
                            r.skill_installed,
                            r.mcp_registered,
                            r.notes
                        ),
                        Err(e) => log::warn!("claude integration failed: {e}"),
                    }
                });
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            // Resume any frozen target on app exit so quitting VibeExtract never leaves
            // a user's app suspended. (A SIGKILL of US can't run this — that case is
            // covered by the on-disk record + resume_orphaned_freeze_on_launch.)
            if matches!(
                event,
                tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
            ) {
                let pid = FROZEN_PID.swap(0, std::sync::atomic::Ordering::SeqCst);
                if pid > 0 {
                    #[cfg(target_os = "macos")]
                    vibe_extract_core::app_freeze_macos::resume(pid);
                }
            }
        });
}
