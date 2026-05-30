// Phase 2-lite: end-to-end "point and click" extraction for Electron apps on macOS.
//
//   1. Wait for the user to hover over an element in any running Electron app
//      that was launched with --remote-debugging-port=<PORT>.
//   2. User presses Enter in this terminal.
//   3. We use the macOS Accessibility API to identify the AX element under the
//      cursor, walk up to its window, and remember the cursor's window-relative
//      position.
//   4. We connect to the CDP port the user passed in, inject the existing
//      VibeExtract `contentScript.js` (UNMODIFIED), translate the cursor's
//      window-local coords to viewport-local coords using `window.outerHeight -
//      window.innerHeight` (titlebar offset), dispatch a real mouse click via
//      CDP at that viewport point, and trigger EXPORT_SELECTION.
//   5. The contentScript returns its usual {toon, html, fontFaces} payload,
//      which we write to disk for inspection.
//
// This is the smallest demo of the full pipeline:
//   AX picker  -->  CDP injection of unmodified contentScript.js  -->  TOON/HTML
// for an existing Electron app on the user's machine.

use anyhow::{anyhow, bail, Context, Result};
use clap::Parser;
use core_foundation::base::{CFGetTypeID, CFRelease, CFTypeRef, TCFType, ToVoid};
use core_foundation::boolean::{kCFBooleanTrue, CFBoolean};
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::{CFString, CFStringRef};
use core_graphics::display::CGPoint;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::ffi::c_void;
use std::path::PathBuf;
use std::time::Duration;
use tokio_tungstenite::{connect_async, tungstenite::Message};

#[derive(Parser, Debug)]
#[command(about = "VibeExtract end-to-end demo — AX picker identifies target on screen, CDP injection extracts pixel-perfect TOON/HTML.")]
struct Args {
    /// CDP debug port the target Electron app is listening on.
    /// Launch the target like:  chrome --remote-debugging-port=9222
    #[arg(long, default_value_t = 9222)]
    port: u16,

    /// Path to contentScript.js (the unmodified browser-extension content script).
    #[arg(long, default_value = "../../contentScript.js")]
    content_script: PathBuf,

    /// Page-target index, for apps with multiple windows.
    #[arg(long, default_value_t = 0)]
    target_index: usize,

    /// Override the cursor position (in screen points, AX coord space, top-left origin).
    /// Format: "X,Y". Useful for scripted testing where the OS cursor cannot easily
    /// be moved over the target window. When set, the binary skips the "press Enter"
    /// prompt and runs immediately.
    #[arg(long)]
    cursor_screen: Option<String>,
}

// =============================================================================
// AX FFI bindings (same as picker-macos)
// =============================================================================

#[allow(non_camel_case_types)]
type AXUIElementRef = *const c_void;
#[allow(non_camel_case_types)]
type AXValueRef = *const c_void;
#[allow(non_camel_case_types)]
type AXError = i32;

const K_AX_ERROR_SUCCESS: AXError = 0;
const K_AX_VALUE_TYPE_CG_POINT: u32 = 1;
const K_AX_VALUE_TYPE_CG_SIZE: u32 = 2;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;
    fn AXUIElementCreateSystemWide() -> AXUIElementRef;
    fn AXUIElementCopyElementAtPosition(
        application: AXUIElementRef,
        x: f32,
        y: f32,
        element: *mut AXUIElementRef,
    ) -> AXError;
    fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: *mut CFTypeRef,
    ) -> AXError;
    fn AXValueGetType(value: AXValueRef) -> u32;
    fn AXValueGetValue(value: AXValueRef, the_type: u32, value_ptr: *mut c_void) -> bool;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventCreate(source: *const c_void) -> *const c_void;
    fn CGEventGetLocation(event: *const c_void) -> CGPoint;
}

struct AxElement(AXUIElementRef);
impl Drop for AxElement {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CFRelease(self.0 as *const _) };
        }
    }
}
impl AxElement {
    fn str_attr(&self, key: &str) -> Option<String> {
        let key_cf = CFString::new(key);
        let mut value: CFTypeRef = std::ptr::null();
        let err = unsafe {
            AXUIElementCopyAttributeValue(self.0, key_cf.as_concrete_TypeRef(), &mut value)
        };
        if err != K_AX_ERROR_SUCCESS || value.is_null() {
            return None;
        }
        let type_id = unsafe { CFGetTypeID(value) };
        if type_id == CFString::type_id() {
            let s = unsafe { CFString::wrap_under_create_rule(value as CFStringRef) };
            Some(s.to_string())
        } else {
            unsafe { CFRelease(value) };
            None
        }
    }
    fn point_attr(&self, key: &str) -> Option<CGPoint> {
        let key_cf = CFString::new(key);
        let mut value: CFTypeRef = std::ptr::null();
        let err = unsafe {
            AXUIElementCopyAttributeValue(self.0, key_cf.as_concrete_TypeRef(), &mut value)
        };
        if err != K_AX_ERROR_SUCCESS || value.is_null() {
            return None;
        }
        let ty = unsafe { AXValueGetType(value as AXValueRef) };
        if ty != K_AX_VALUE_TYPE_CG_POINT {
            unsafe { CFRelease(value) };
            return None;
        }
        let mut pt = CGPoint { x: 0.0, y: 0.0 };
        let ok = unsafe {
            AXValueGetValue(
                value as AXValueRef,
                K_AX_VALUE_TYPE_CG_POINT,
                &mut pt as *mut CGPoint as *mut c_void,
            )
        };
        unsafe { CFRelease(value) };
        if ok { Some(pt) } else { None }
    }
    fn size_attr(&self, key: &str) -> Option<(f64, f64)> {
        let key_cf = CFString::new(key);
        let mut value: CFTypeRef = std::ptr::null();
        let err = unsafe {
            AXUIElementCopyAttributeValue(self.0, key_cf.as_concrete_TypeRef(), &mut value)
        };
        if err != K_AX_ERROR_SUCCESS || value.is_null() {
            return None;
        }
        let ty = unsafe { AXValueGetType(value as AXValueRef) };
        if ty != K_AX_VALUE_TYPE_CG_SIZE {
            unsafe { CFRelease(value) };
            return None;
        }
        #[repr(C)]
        struct CGSize { width: f64, height: f64 }
        let mut sz = CGSize { width: 0.0, height: 0.0 };
        let ok = unsafe {
            AXValueGetValue(
                value as AXValueRef,
                K_AX_VALUE_TYPE_CG_SIZE,
                &mut sz as *mut CGSize as *mut c_void,
            )
        };
        unsafe { CFRelease(value) };
        if ok { Some((sz.width, sz.height)) } else { None }
    }
    /// Walk up AXParent links until we hit AXRole == "AXWindow" (or run out).
    fn enclosing_window(&self) -> Option<AxElement> {
        // The element itself might be the window.
        if let Some(role) = self.str_attr("AXRole") {
            if role == "AXWindow" {
                // Re-wrap by retaining; we want an owned ref independent of self.
                // For simplicity, just return None here — caller can use self.
                return None;
            }
        }
        let mut current = self.0;
        // Bound the walk to avoid infinite loops on weird AX trees.
        for _ in 0..50 {
            let key_cf = CFString::new("AXParent");
            let mut parent: CFTypeRef = std::ptr::null();
            let err = unsafe { AXUIElementCopyAttributeValue(current, key_cf.as_concrete_TypeRef(), &mut parent) };
            if err != K_AX_ERROR_SUCCESS || parent.is_null() {
                return None;
            }
            // Take ownership of the parent ref via AxElement so it auto-releases.
            let wrapped = AxElement(parent as AXUIElementRef);
            let role = wrapped.str_attr("AXRole").unwrap_or_default();
            if role == "AXWindow" {
                return Some(wrapped);
            }
            current = wrapped.0;
            // Don't drop wrapped here — but we need its ptr to keep walking.
            // Trick: forget wrapped so it doesn't release, and let the next
            // iteration release the one we just retrieved.
            std::mem::forget(wrapped);
        }
        None
    }
}

fn current_cursor() -> CGPoint {
    unsafe {
        let event = CGEventCreate(std::ptr::null());
        if event.is_null() {
            return CGPoint { x: -1.0, y: -1.0 };
        }
        let pt = CGEventGetLocation(event);
        CFRelease(event);
        pt
    }
}

fn element_under_cursor(system: AXUIElementRef, pt: CGPoint) -> Option<AxElement> {
    let mut out: AXUIElementRef = std::ptr::null();
    let err = unsafe { AXUIElementCopyElementAtPosition(system, pt.x as f32, pt.y as f32, &mut out) };
    if err != K_AX_ERROR_SUCCESS || out.is_null() {
        None
    } else {
        Some(AxElement(out))
    }
}

fn check_ax_permission() -> bool {
    if unsafe { AXIsProcessTrusted() } {
        return true;
    }
    let key = CFString::from_static_string("AXTrustedCheckOptionPrompt");
    let value = unsafe { CFBoolean::wrap_under_get_rule(kCFBooleanTrue) };
    let dict: CFDictionary<CFString, CFBoolean> = CFDictionary::from_CFType_pairs(&[(key, value)]);
    unsafe { AXIsProcessTrustedWithOptions(dict.to_void()) }
}

// =============================================================================
// CDP (same as spike)
// =============================================================================

#[derive(Debug, Deserialize)]
struct PageTarget {
    #[serde(rename = "type")]
    target_type: String,
    title: String,
    url: String,
    #[serde(rename = "webSocketDebuggerUrl")]
    ws_url: Option<String>,
}

#[derive(Debug, Serialize)]
struct CdpCommand {
    id: u64,
    method: String,
    params: Value,
}

async fn discover_target(port: u16, index: usize) -> Result<String> {
    let url = format!("http://127.0.0.1:{port}/json");
    let targets: Vec<PageTarget> = reqwest::get(&url)
        .await
        .with_context(|| format!("HTTP GET {url} — is the target Electron app running with --remote-debugging-port={port}?"))?
        .json()
        .await
        .context("parsing /json")?;
    let pages: Vec<&PageTarget> = targets.iter().filter(|t| t.target_type == "page" && t.ws_url.is_some()).collect();
    if pages.is_empty() {
        bail!("no page targets on port {port}");
    }
    let chosen = pages.get(index).copied().ok_or_else(|| anyhow!("target_index out of range"))?;
    eprintln!("[combo] CDP target: {} ({})", chosen.title, chosen.url);
    Ok(chosen.ws_url.clone().unwrap())
}

async fn call<S>(socket: &mut S, cmd: CdpCommand) -> Result<Value>
where
    S: SinkExt<Message, Error = tokio_tungstenite::tungstenite::Error>
        + StreamExt<Item = std::result::Result<Message, tokio_tungstenite::tungstenite::Error>>
        + Unpin,
{
    let cmd_id = cmd.id;
    let cmd_method = cmd.method.clone();
    let payload = serde_json::to_string(&cmd)?;
    socket.send(Message::Text(payload)).await.context("CDP send")?;
    loop {
        let msg = socket.next().await.ok_or_else(|| anyhow!("CDP stream closed"))?.context("CDP recv")?;
        let text = match msg {
            Message::Text(t) => t,
            Message::Binary(_) | Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => continue,
            Message::Close(_) => bail!("CDP socket closed"),
        };
        let val: Value = serde_json::from_str(&text).context("CDP JSON parse")?;
        match val.get("id").and_then(|i| i.as_u64()) {
            Some(id) if id == cmd_id => {
                if let Some(err) = val.get("error") {
                    bail!("CDP {} returned error: {}", cmd_method, err);
                }
                return Ok(val.get("result").cloned().unwrap_or(Value::Null));
            }
            _ => continue,
        }
    }
}

async fn eval<S>(socket: &mut S, cmd: CdpCommand) -> Result<Value>
where
    S: SinkExt<Message, Error = tokio_tungstenite::tungstenite::Error>
        + StreamExt<Item = std::result::Result<Message, tokio_tungstenite::tungstenite::Error>>
        + Unpin,
{
    let r = call(socket, cmd).await?;
    if let Some(exc) = r.get("exceptionDetails") {
        bail!("Runtime.evaluate threw: {}", exc);
    }
    Ok(r)
}

// =============================================================================
// End-to-end flow
// =============================================================================

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();

    eprintln!("[combo] checking AX permission...");
    if !check_ax_permission() {
        let _ = std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
            .status();
        bail!("AX permission denied — grant it in System Settings, then re-run.");
    }

    let content_script = std::fs::read_to_string(&args.content_script)
        .with_context(|| format!("reading contentScript.js from {}", args.content_script.display()))?;
    eprintln!("[combo] loaded contentScript.js ({} bytes)", content_script.len());

    // --- Step 1: get cursor screen position --------------------------------
    let cursor = match &args.cursor_screen {
        Some(s) => {
            let (xs, ys) = s.split_once(',').ok_or_else(|| anyhow!("--cursor-screen must be 'X,Y'"))?;
            let x: f64 = xs.trim().parse().context("parsing X in --cursor-screen")?;
            let y: f64 = ys.trim().parse().context("parsing Y in --cursor-screen")?;
            eprintln!("[combo] using --cursor-screen override ({}, {})", x, y);
            CGPoint { x, y }
        }
        None => {
            eprintln!("\n[combo] hover over an element in your target Electron app, then press Enter here.");
            eprintln!("(target app must already be running with --remote-debugging-port={})", args.port);
            let mut line = String::new();
            std::io::stdin().read_line(&mut line).context("read enter from stdin")?;
            current_cursor()
        }
    };
    eprintln!("[combo] cursor at screen ({:.0}, {:.0})", cursor.x, cursor.y);
    let system = unsafe { AXUIElementCreateSystemWide() };
    let element = element_under_cursor(system, cursor).ok_or_else(|| anyhow!("no AX element at cursor"))?;
    let role = element.str_attr("AXRole").unwrap_or_else(|| "?".into());
    let name = element.str_attr("AXTitle")
        .or_else(|| element.str_attr("AXDescription"))
        .unwrap_or_else(|| "(anon)".into());
    eprintln!("[combo] AX element: {} \"{}\"", role, name);

    let window = element.enclosing_window().ok_or_else(|| anyhow!("no enclosing AXWindow — cursor not over an app window?"))?;
    let win_pos = window.point_attr("AXPosition").ok_or_else(|| anyhow!("window has no AXPosition"))?;
    let win_size = window.size_attr("AXSize").ok_or_else(|| anyhow!("window has no AXSize"))?;
    let win_title = window.str_attr("AXTitle").unwrap_or_default();
    eprintln!("[combo] window \"{}\" at screen ({:.0},{:.0}) size {:.0}x{:.0}", win_title, win_pos.x, win_pos.y, win_size.0, win_size.1);

    // Sanity: if the AX window's title clearly doesn't look like a browser/Electron app,
    // the cursor is probably over an unrelated window in front of the CDP target.
    // We can't know the target's title before connecting, so just warn loudly here —
    // the real CDP-target check happens once we know its title (see "[combo] CDP target:" below).
    let win_title_ok = win_title.to_lowercase().contains("chrome")
        || win_title.to_lowercase().contains("electron")
        || win_title.to_lowercase().contains("slack")
        || win_title.to_lowercase().contains("discord")
        || win_title.to_lowercase().contains("vs code")
        || win_title.to_lowercase().contains("visual studio code");
    if !win_title_ok {
        eprintln!(
            "[combo] WARNING: the topmost window at the cursor (\"{}\") doesn't look like a Chromium/Electron app.\n         \
             If extraction fails with 'empty result', another window is probably in front of your CDP target.\n         \
             Fix: bring the target to front first, e.g.  osascript -e 'tell application \"Google Chrome\" to activate'",
            win_title
        );
    }

    // Cursor position relative to the window's top-left, in points.
    let win_local_x = cursor.x - win_pos.x;
    let win_local_y = cursor.y - win_pos.y;
    eprintln!("[combo] cursor inside window at ({:.0}, {:.0})", win_local_x, win_local_y);

    // --- Step 3: CDP attach + inject contentScript.js + click + export -------
    let ws_url = discover_target(args.port, args.target_index).await?;
    let (mut socket, _) = connect_async(&ws_url).await.context("CDP WS connect")?;
    let mut next_id: u64 = 0;
    let mut mk = |method: &str, params: Value| -> CdpCommand {
        next_id += 1;
        CdpCommand { id: next_id, method: method.to_string(), params }
    };

    call(&mut socket, mk("Runtime.enable", json!({}))).await?;
    call(&mut socket, mk("Page.enable", json!({}))).await?;

    let inject = format!(
        "(function(){{try{{{}\n}}catch(e){{console.warn('[VibeExtract combo] inject:',e);}}}})();",
        content_script
    );
    eval(&mut socket, mk("Runtime.evaluate", json!({
        "expression": inject,
        "awaitPromise": false,
        "returnByValue": true,
    }))).await?;
    eprintln!("[combo] contentScript.js injected");

    // Get viewport size and chrome offset so we can translate window-local -> viewport coords.
    // `window.outerHeight - window.innerHeight` gives titlebar height (0 for frameless windows).
    let metrics = eval(&mut socket, mk("Runtime.evaluate", json!({
        "expression": "({outerW: window.outerWidth, outerH: window.outerHeight, innerW: window.innerWidth, innerH: window.innerHeight, dpr: window.devicePixelRatio})",
        "returnByValue": true,
    }))).await?;
    let m = metrics.get("result").and_then(|r| r.get("value")).cloned().unwrap_or(Value::Null);
    let inner_w = m.get("innerW").and_then(|v| v.as_f64()).unwrap_or(win_size.0);
    let inner_h = m.get("innerH").and_then(|v| v.as_f64()).unwrap_or(win_size.1);
    let outer_h = m.get("outerH").and_then(|v| v.as_f64()).unwrap_or(win_size.1);
    let chrome_y = (outer_h - inner_h).max(0.0);
    let dpr = m.get("dpr").and_then(|v| v.as_f64()).unwrap_or(1.0);
    eprintln!("[combo] viewport: {:.0}x{:.0}, chrome_y={:.0}, dpr={:.1}", inner_w, inner_h, chrome_y, dpr);

    // Window-local (points) to viewport (CSS pixels):
    //   viewport coords are also in CSS pixels (Input.dispatchMouseEvent expects CSS px),
    //   so we just subtract the titlebar offset.
    let viewport_x = win_local_x;
    let viewport_y = win_local_y - chrome_y;
    if viewport_x < 0.0 || viewport_y < 0.0 || viewport_x > inner_w || viewport_y > inner_h {
        bail!(
            "translated viewport coords ({:.0}, {:.0}) are outside the viewport bounds ({:.0}x{:.0}). \
             Are you sure the cursor was over the web-contents area (not the titlebar) of the CDP target?",
            viewport_x, viewport_y, inner_w, inner_h
        );
    }
    eprintln!("[combo] viewport-local target: ({:.0}, {:.0})", viewport_x, viewport_y);

    // Arm pick mode in contentScript.
    eval(&mut socket, mk("Runtime.evaluate", json!({
        "expression": "window.postMessage({fromParent:true, msgId:1, type:'START_PICK_MODE'}, '*'); 'armed'",
        "returnByValue": true,
    }))).await?;

    // Synthesize a click at the translated viewport coords.
    call(&mut socket, mk("Input.dispatchMouseEvent", json!({
        "type": "mousePressed",
        "x": viewport_x,
        "y": viewport_y,
        "button": "left",
        "buttons": 1,
        "clickCount": 1,
    }))).await?;
    call(&mut socket, mk("Input.dispatchMouseEvent", json!({
        "type": "mouseReleased",
        "x": viewport_x,
        "y": viewport_y,
        "button": "left",
        "buttons": 0,
        "clickCount": 1,
    }))).await?;
    tokio::time::sleep(Duration::from_millis(200)).await;

    // Export.
    let export_js = r#"
        new Promise((resolve) => {
            const msgId = Math.random().toString(36).slice(2);
            const handler = (event) => {
                if (event.data && event.data.msgId === msgId && 'result' in event.data) {
                    window.removeEventListener('message', handler);
                    resolve(event.data.result);
                }
            };
            window.addEventListener('message', handler);
            window.postMessage({fromParent:true, msgId, type:'EXPORT_SELECTION'}, '*');
            setTimeout(() => {
                window.removeEventListener('message', handler);
                resolve({error:'EXPORT_SELECTION timed out — was the click intercepted?'});
            }, 5000);
        })
    "#;
    let result = eval(&mut socket, mk("Runtime.evaluate", json!({
        "expression": export_js,
        "awaitPromise": true,
        "returnByValue": true,
    }))).await?;
    let payload = result.get("result").and_then(|r| r.get("value")).cloned()
        .ok_or_else(|| anyhow!("EXPORT_SELECTION returned no value"))?;
    if let Some(err) = payload.get("error").and_then(|v| v.as_str()) {
        bail!("export failed: {}", err);
    }
    let toon = payload.get("toon").and_then(|v| v.as_str()).unwrap_or("");
    let html = payload.get("html").and_then(|v| v.as_str()).unwrap_or("");
    if toon.is_empty() && html.is_empty() {
        bail!("export returned empty result — was anything selected? Payload: {}", payload);
    }
    eprintln!("[combo] success — toon: {} bytes, html: {} bytes", toon.len(), html.len());
    std::fs::write("combo-output.toon", toon).context("writing combo-output.toon")?;
    std::fs::write("combo-output.html", html).context("writing combo-output.html")?;
    eprintln!("[combo] wrote combo-output.toon and combo-output.html");

    Ok(())
}
