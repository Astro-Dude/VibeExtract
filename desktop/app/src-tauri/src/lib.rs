//! VibeExtract Desktop — Tauri shell.
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
    picked_summary: String,
    count: usize,
}

fn dirs_home() -> PathBuf {
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn find_output_dir() -> PathBuf {
    let dir = dirs_home().join("Documents").join("VibeExtract Captures");
    let _ = std::fs::create_dir_all(&dir);
    dir
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

    if target_pid.is_none() {
        let _ = app.emit(
            "toast",
            "No recent target app. Click on Slack / Finder / any app you want to extract from, then press ⌘⇧S.".to_string(),
        );
        return Err("no target app".into());
    }

    // Wake the target NOW (before showing overlay), then sleep so Electron has
    // time to build its AX tree before the first hover hit.
    #[cfg(target_os = "macos")]
    if let Some(pid) = target_pid {
        vibe_extract_core::ax_macos::wake_app_ax(pid);
    }
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    // Reset session state. CRITICAL: clear `last_hover` too — a stale
    // PickedElement from a prior session (often VibeExtract's own AXMenuBar
    // due to Apple's global hit-test behavior, see ax_macos.rs notes) will
    // otherwise be returned by the first overlay_click of the new session.
    {
        let state = app.state::<PickSessionState>();
        let mut s = state.0.lock().unwrap();
        s.active = true;
        s.selected.clear();
        s.locked_pid = None;
        s.woken_pids.clear();
        s.target_pid = target_pid;
        s.last_hover = None;
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

    // Register Esc and ↑/↓ as temporary global shortcuts. Esc cancels pick
    // mode; ↑/↓ walk the AX ancestry of the currently hovered element so the
    // user can select a larger / smaller region than Apple's AX hit-test
    // returns by default. Unregistered in stop_pick_mode so we don't steal
    // these keys from other apps while VibeExtract isn't actively picking.
    let pick_keys = [
        (Shortcut::new(None, Code::Escape), "Esc"),
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
    }
    // Drop the event tap — restores normal click behaviour for the user.
    #[cfg(target_os = "macos")]
    {
        let tap_state = app.state::<EventTapState>();
        let mut guard = tap_state.0.lock().unwrap();
        if guard.is_some() {
            drop(guard.take()); // explicit Drop call
            log::info!("event_tap: dropped on stop_pick_mode");
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
    Ok(())
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
        let guard = s.0.lock().unwrap();
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

    // Electron apps need their AX tree woken before the subtree walk produces
    // anything useful. Wake on the first click into a new pid and re-pick so
    // the captured PickedElement reflects the now-populated tree.
    #[cfg(target_os = "macos")]
    {
        let needs_wake = {
            let s = app.state::<PickSessionState>();
            let mut guard = s.0.lock().unwrap();
            if picked.pid > 0 && !guard.woken_pids.contains(&picked.pid) {
                guard.woken_pids.insert(picked.pid);
                true
            } else {
                false
            }
        };
        if needs_wake {
            vibe_extract_core::ax_macos::wake_app_ax(picked.pid);
            tokio::time::sleep(std::time::Duration::from_millis(80)).await;
            if let Ok(repicked) =
                vibe_extract_core::picker::pick_under_cursor(Some(point))
            {
                picked = repicked;
            }
        }
    }

    // Same-app constraint when shift-clicking.
    let state = app.state::<PickSessionState>();
    let new_selected_list = {
        let mut s = state.0.lock().unwrap();
        if !s.active {
            return Err("pick mode not active".into());
        }
        if shift {
            if let Some(locked) = s.locked_pid {
                if picked.pid != locked {
                    return Err(format!(
                        "Cross-app selection not allowed (locked to pid {}). Press Escape to start over.",
                        locked
                    ));
                }
            }
            s.selected.push(picked.clone());
            if s.locked_pid.is_none() {
                s.locked_pid = Some(picked.pid);
            }
        } else {
            s.selected.clear();
            s.selected.push(picked.clone());
            s.locked_pid = Some(picked.pid);
        }
        s.selected.clone()
    };

    // Push updated outlines to the overlay.
    if let Some(overlay) = app.get_webview_window("overlay") {
        let payload: Vec<OverlaySelectedPayload> = new_selected_list
            .iter()
            .map(|p| OverlaySelectedPayload {
                bounds: to_overlay_bounds(&p.bounds),
                role: p.role.clone(),
                name: p.name.clone(),
            })
            .collect();
        let _ = overlay.emit("overlay-selections", payload);
    }

    log::info!(
        "overlay_click: selection list now has {} element(s)",
        new_selected_list.len()
    );

    // Update main window's counter.
    let _ = app.emit("selection-count-changed", new_selected_list.len());

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
    let out_dir = app.state::<OutputDir>().inner().0.clone();

    // Hide the overlay BEFORE running the extractor so its screenshot step
    // doesn't capture our own HUD/outline pixels. NOTE: do NOT move the
    // window off-screen — that's been observed to "stick" so the overlay
    // doesn't come back properly on the next start_pick_mode call.
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
    let result = match first_attempt {
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
    // Snapshot the current hover so we don't hold the mutex across AX FFI.
    let (target_pid_opt, current) = {
        let state = app.state::<PickSessionState>();
        let s = state.0.lock().unwrap();
        if !s.active {
            return Err("pick mode not active".into());
        }
        (s.target_pid, s.last_hover.clone())
    };
    let Some(current) = current else {
        return Err("no hovered element to walk from".into());
    };
    let our_pid = std::process::id() as i32;

    // All AX work in a sync block so the (non-Send) AxElement handles drop
    // before any .await.
    let new_picked = {
        // Re-acquire an AX handle for the current element. We have its bounds
        // — hit-test at the center of the bounds via the target app's tree.
        let center = current.bounds.center();
        let cur_el = if let Some(pid) = target_pid_opt {
            vibe_extract_core::ax_macos::element_at_in_app(center, pid)
        } else {
            vibe_extract_core::ax_macos::element_at(center)
        };
        let Some(cur_el) = cur_el else {
            return Err("couldn't re-acquire AX handle for current hover".into());
        };

        if go_up {
            // Walk to the immediate parent. Reject if it leaves the target
            // app (e.g. parent is system root) or if the bounds are bogus.
            let Some(parent) = cur_el.parent() else {
                return Err("already at AX root — can't go higher".into());
            };
            let role = parent.str_attr("AXRole").unwrap_or_default();
            let bounds = match parent.rect() {
                Some(b) if b.w >= 1.0 && b.h >= 1.0 => b,
                _ => {
                    return Err(format!(
                        "parent {} has no usable bounds — staying at current",
                        role
                    ))
                }
            };
            let pid = parent.pid().unwrap_or(-1);
            if pid == our_pid {
                return Err("parent is in our own process — refusing to walk".into());
            }
            let name = parent
                .str_attr("AXTitle")
                .or_else(|| parent.str_attr("AXDescription"))
                .or_else(|| parent.str_attr("AXLabel"))
                .or_else(|| parent.str_attr("AXValue"))
                .unwrap_or_default();
            PickedElement {
                role,
                subrole: parent.str_attr("AXSubrole").filter(|s| !s.is_empty()),
                name,
                identifier: parent.str_attr("AXIdentifier").filter(|s| !s.is_empty()),
                bounds,
                pid,
                app_path: vibe_extract_core::ax_macos::pid_to_path(pid),
                window_title: None,
                window_bounds: parent.enclosing_window().and_then(|w| w.rect()),
            }
        } else {
            // Walk DOWN: find the deepest descendant under the cursor (or the
            // bounds center if cursor isn't over the element anymore).
            let pt = {
                let c = vibe_extract_core::ax_macos::current_cursor();
                if c.x >= current.bounds.x
                    && c.x <= current.bounds.x + current.bounds.w
                    && c.y >= current.bounds.y
                    && c.y <= current.bounds.y + current.bounds.h
                {
                    c
                } else {
                    current.bounds.center()
                }
            };
            let deeper = vibe_extract_core::ax_macos::deepen_at(cur_el, pt);
            let role = deeper.str_attr("AXRole").unwrap_or_default();
            let bounds = match deeper.rect() {
                Some(b) if b.w >= 1.0 && b.h >= 1.0 => b,
                _ => return Err(format!("child {} has no bounds", role)),
            };
            if bounds.w >= current.bounds.w && bounds.h >= current.bounds.h {
                // No real deeper element — same or bigger. Nothing to go to.
                return Err("no deeper element under cursor".into());
            }
            let pid = deeper.pid().unwrap_or(-1);
            let name = deeper
                .str_attr("AXTitle")
                .or_else(|| deeper.str_attr("AXDescription"))
                .or_else(|| deeper.str_attr("AXLabel"))
                .or_else(|| deeper.str_attr("AXValue"))
                .unwrap_or_default();
            PickedElement {
                role,
                subrole: deeper.str_attr("AXSubrole").filter(|s| !s.is_empty()),
                name,
                identifier: deeper.str_attr("AXIdentifier").filter(|s| !s.is_empty()),
                bounds,
                pid,
                app_path: vibe_extract_core::ax_macos::pid_to_path(pid),
                window_title: None,
                window_bounds: deeper.enclosing_window().and_then(|w| w.rect()),
            }
        }
    };

    log::info!(
        "walk_hover_ancestry({}): now {} \"{}\" bounds={}x{}",
        if go_up { "up" } else { "down" },
        new_picked.role,
        new_picked.name,
        new_picked.bounds.w,
        new_picked.bounds.h
    );

    // Push the new element into last_hover so the very next click commits it.
    // Also push an outline event so the overlay redraws immediately.
    {
        let state = app.state::<PickSessionState>();
        let mut s = state.0.lock().unwrap();
        s.last_hover = Some(new_picked.clone());
    }
    if let Some(overlay) = app.get_webview_window("overlay") {
        let payload = OverlayHoverPayload {
            bounds: Some(OverlayBounds {
                x: new_picked.bounds.x,
                y: new_picked.bounds.y,
                w: new_picked.bounds.w,
                h: new_picked.bounds.h,
            }),
            role: new_picked.role.clone(),
            name: new_picked.name.clone(),
            cursor: OverlayCursor {
                x: vibe_extract_core::ax_macos::current_cursor().x,
                y: vibe_extract_core::ax_macos::current_cursor().y,
            },
        };
        let _ = overlay.emit("overlay-hover", payload);
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
async fn walk_hover_ancestry(_app: AppHandle, _go_up: bool) -> Result<(), String> {
    Err("walk_hover_ancestry only implemented on macOS".into())
}

#[tauri::command]
async fn save_to_disk(name: String, contents: String) -> Result<String, String> {
    use std::io::Write;
    let dir = dirs_home().join("Documents").join("VibeExtract Captures");
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
                        } else if combo.contains("ArrowUp")
                            || combo.contains("ArrowDown")
                        {
                            // Parent / child walk during pick mode. Updates
                            // `last_hover` to the new element so the next click
                            // (or the current outline) reflects the broader
                            // ancestor (Up) or the deeper child (Down).
                            let go_up = combo.contains("ArrowUp");
                            if let Err(e) = walk_hover_ancestry(app.clone(), go_up).await {
                                log::debug!("walk_hover_ancestry: {}", e);
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
            check_ax_permission,
            request_ax_permission,
            start_pick_mode,
            stop_pick_mode,
            overlay_click,
            export_selection,
            extract_frontmost_window_cmd,
            save_to_disk,
            get_relaunch_dialog_info,
            relaunch_dialog_response,
            get_settings_cmd,
            set_electron_pref_cmd,
            known_electron_apps,
            mcp::mcp_status,
            mcp::mcp_toggle,
        ])
        .setup(|app| {
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
                loop {
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                    #[cfg(target_os = "macos")]
                    {
                        if let Some(pid) = frontmost_app_pid_via_nsworkspace() {
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
                    }
                }
            });

            // Optional: auto-start the MCP server (for headless/E2E testing or
            // users who always want it on). Off unless VIBE_MCP_AUTOSTART is set.
            if std::env::var_os("VIBE_MCP_AUTOSTART").is_some() {
                let h = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    match mcp::start(h).await {
                        Ok(s) => log::info!("MCP auto-started: {:?}", s.url),
                        Err(e) => log::error!("MCP auto-start failed: {e}"),
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
