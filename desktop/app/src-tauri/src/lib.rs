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

use vibe_extract_core::{capture::ScreenPoint, dispatcher, picker::PickedElement};

/// `contentScript.js` embedded at compile time. Path is relative to *this*
/// source file (src/lib.rs): 4 levels up to repo root.
const CONTENT_SCRIPT: &str = include_str!("../../../../contentScript.js");

/// Where capture outputs are written.
struct OutputDir(PathBuf);

/// Hotkey config that the UI may rebind at runtime.
#[derive(Default)]
struct RegisteredHotkeys(Mutex<Vec<Shortcut>>);

/// Selected elements during the current pick session.
#[derive(Default)]
struct PickSession {
    active: bool,
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

    // Reset session state.
    {
        let state = app.state::<PickSessionState>();
        let mut s = state.0.lock().unwrap();
        s.active = true;
        s.selected.clear();
        s.locked_pid = None;
        s.woken_pids.clear();
        s.target_pid = target_pid;
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
    let pick_result: Result<PickedElement, String> = {
        let cached_hover = {
            let s = app.state::<PickSessionState>();
            let guard = s.0.lock().unwrap();
            guard.last_hover.clone()
        };
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

    let result = dispatcher::extract_multi(&selected, CONTENT_SCRIPT, &out_dir)
        .await
        .map_err(|e| e.to_string())?;

    // Tear down pick mode after a successful export.
    let _ = stop_pick_mode(app.clone()).await;

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
    let result = dispatcher::extract_frontmost_window(CONTENT_SCRIPT, &out_dir)
        .await
        .map_err(|e| e.to_string())?;
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
                                        app_path: None,
                                        window_title: None,
                                        window_bounds: None,
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
                            // Even when no element found, send cursor so the
                            // crosshair still follows the mouse.
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
                            let active = app
                                .try_state::<PickSessionState>()
                                .map(|s| s.0.lock().unwrap().active)
                                .unwrap_or(false);
                            if active {
                                let _ = stop_pick_mode(app).await;
                            } else {
                                if let Err(e) = start_pick_mode(app).await {
                                    log::warn!("start_pick_mode failed: {}", e);
                                }
                            }
                        } else if combo.contains("KeyE") {
                            match export_selection(app.clone()).await {
                                Ok(payload) => {
                                    let _ = app.emit("export-result", payload);
                                    raise_main_window(&app);
                                }
                                Err(e) => {
                                    log::warn!("export failed: {}", e);
                                    let _ = app.emit(
                                        "toast",
                                        format!("Export failed: {} — select at least one element with Cmd+Shift+S then click on it.", e),
                                    );
                                    raise_main_window(&app);
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
        .invoke_handler(tauri::generate_handler![
            check_ax_permission,
            request_ax_permission,
            start_pick_mode,
            stop_pick_mode,
            overlay_click,
            export_selection,
            extract_frontmost_window_cmd,
            save_to_disk,
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

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
