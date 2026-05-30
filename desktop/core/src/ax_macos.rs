//! macOS Accessibility API — picker + subtree walk.
//!
//! Same FFI surface that's inlined into the native-extract binary, lifted into
//! a library and made reusable. Public API:
//!
//! - [`check_permission`] — `AXIsProcessTrusted`, with prompt
//! - [`current_cursor`] — `CGEventGetLocation`
//! - [`pick`] — hit-test at a screen point, walk to enclosing window, return [`crate::capture::PickedElement`]
//! - [`walk_subtree`] — recursive AX walk that produces a [`Node`] tree
//! - [`Node`] — what the native extractor consumes

use crate::capture::{PickedElement, ScreenPoint, ScreenRect};
use anyhow::{anyhow, bail, Result};
use core_foundation::array::{CFArray, CFArrayRef};
use core_foundation::base::{CFGetTypeID, CFRelease, CFTypeRef, TCFType, ToVoid};
use core_foundation::boolean::{kCFBooleanTrue, CFBoolean};
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::{CFString, CFStringRef};
use core_graphics::display::CGPoint;
use serde::{Deserialize, Serialize};
use std::ffi::c_void;

// --- FFI ---------------------------------------------------------------------

#[allow(non_camel_case_types)]
pub type AXUIElementRef = *const c_void;
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
    fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
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
    fn AXUIElementSetAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: CFTypeRef,
    ) -> AXError;
    fn AXUIElementGetPid(element: AXUIElementRef, pid: *mut i32) -> AXError;
    fn AXValueGetType(value: AXValueRef) -> u32;
    fn AXValueGetValue(value: AXValueRef, the_type: u32, value_ptr: *mut c_void) -> bool;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventCreate(source: *const c_void) -> *const c_void;
    fn CGEventGetLocation(event: *const c_void) -> CGPoint;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRetain(cf: *const c_void) -> *const c_void;
    fn CFArrayGetTypeID() -> usize;
}

// --- Safe wrappers -----------------------------------------------------------

pub struct AxElement(pub AXUIElementRef);
impl Drop for AxElement {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CFRelease(self.0 as *const _) };
        }
    }
}

impl AxElement {
    pub fn pid(&self) -> Option<i32> {
        let mut p: i32 = 0;
        let err = unsafe { AXUIElementGetPid(self.0, &mut p) };
        if err == K_AX_ERROR_SUCCESS {
            Some(p)
        } else {
            None
        }
    }

    pub fn str_attr(&self, key: &str) -> Option<String> {
        let key_cf = CFString::new(key);
        let mut value: CFTypeRef = std::ptr::null();
        let err =
            unsafe { AXUIElementCopyAttributeValue(self.0, key_cf.as_concrete_TypeRef(), &mut value) };
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

    pub fn point_attr(&self, key: &str) -> Option<ScreenPoint> {
        let key_cf = CFString::new(key);
        let mut value: CFTypeRef = std::ptr::null();
        let err =
            unsafe { AXUIElementCopyAttributeValue(self.0, key_cf.as_concrete_TypeRef(), &mut value) };
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
        if ok {
            Some(ScreenPoint { x: pt.x, y: pt.y })
        } else {
            None
        }
    }

    pub fn size_attr(&self, key: &str) -> Option<(f64, f64)> {
        #[repr(C)]
        struct CGSize {
            width: f64,
            height: f64,
        }
        let key_cf = CFString::new(key);
        let mut value: CFTypeRef = std::ptr::null();
        let err =
            unsafe { AXUIElementCopyAttributeValue(self.0, key_cf.as_concrete_TypeRef(), &mut value) };
        if err != K_AX_ERROR_SUCCESS || value.is_null() {
            return None;
        }
        let ty = unsafe { AXValueGetType(value as AXValueRef) };
        if ty != K_AX_VALUE_TYPE_CG_SIZE {
            unsafe { CFRelease(value) };
            return None;
        }
        let mut sz = CGSize { width: 0.0, height: 0.0 };
        let ok = unsafe {
            AXValueGetValue(
                value as AXValueRef,
                K_AX_VALUE_TYPE_CG_SIZE,
                &mut sz as *mut CGSize as *mut c_void,
            )
        };
        unsafe { CFRelease(value) };
        if ok {
            Some((sz.width, sz.height))
        } else {
            None
        }
    }

    pub fn rect(&self) -> Option<ScreenRect> {
        let pt = self.point_attr("AXPosition")?;
        let (w, h) = self.size_attr("AXSize")?;
        Some(ScreenRect {
            x: pt.x,
            y: pt.y,
            w,
            h,
        })
    }

    pub fn array_attr(&self, key: &str) -> Vec<AxElement> {
        let key_cf = CFString::new(key);
        let mut value: CFTypeRef = std::ptr::null();
        let err =
            unsafe { AXUIElementCopyAttributeValue(self.0, key_cf.as_concrete_TypeRef(), &mut value) };
        if err != K_AX_ERROR_SUCCESS || value.is_null() {
            return Vec::new();
        }
        let type_id = unsafe { CFGetTypeID(value) };
        if type_id != unsafe { CFArrayGetTypeID() } {
            unsafe { CFRelease(value) };
            return Vec::new();
        }
        let array = unsafe { CFArray::<*const c_void>::wrap_under_create_rule(value as CFArrayRef) };
        let len = array.len();
        let mut out = Vec::with_capacity(len as usize);
        for i in 0..len {
            let item = array.get(i).map(|r| *r).unwrap_or(std::ptr::null());
            if item.is_null() {
                continue;
            }
            unsafe { CFRetain(item as *const _) };
            out.push(AxElement(item as AXUIElementRef));
        }
        out
    }

    pub fn enclosing_window(&self) -> Option<AxElement> {
        if let Some(role) = self.str_attr("AXRole") {
            if role == "AXWindow" {
                // Re-wrap by retaining self's ref so caller gets its own owned element.
                unsafe { CFRetain(self.0 as *const _) };
                return Some(AxElement(self.0));
            }
        }
        let mut current = self.0;
        for _ in 0..50 {
            let key_cf = CFString::new("AXParent");
            let mut parent: CFTypeRef = std::ptr::null();
            let err =
                unsafe { AXUIElementCopyAttributeValue(current, key_cf.as_concrete_TypeRef(), &mut parent) };
            if err != K_AX_ERROR_SUCCESS || parent.is_null() {
                return None;
            }
            let wrapped = AxElement(parent as AXUIElementRef);
            let role = wrapped.str_attr("AXRole").unwrap_or_default();
            if role == "AXWindow" {
                return Some(wrapped);
            }
            current = wrapped.0;
            std::mem::forget(wrapped);
        }
        None
    }
}

// --- Permission / cursor / hit-test ------------------------------------------

pub fn check_permission(prompt: bool) -> bool {
    if unsafe { AXIsProcessTrusted() } {
        return true;
    }
    if !prompt {
        return false;
    }
    let key = CFString::from_static_string("AXTrustedCheckOptionPrompt");
    let value = unsafe { CFBoolean::wrap_under_get_rule(kCFBooleanTrue) };
    let dict: CFDictionary<CFString, CFBoolean> = CFDictionary::from_CFType_pairs(&[(key, value)]);
    unsafe { AXIsProcessTrustedWithOptions(dict.to_void()) }
}

pub fn open_accessibility_settings() {
    let _ = std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        .status();
}

pub fn current_cursor() -> ScreenPoint {
    unsafe {
        let event = CGEventCreate(std::ptr::null());
        if event.is_null() {
            return ScreenPoint { x: -1.0, y: -1.0 };
        }
        let pt = CGEventGetLocation(event);
        CFRelease(event);
        ScreenPoint { x: pt.x, y: pt.y }
    }
}

/// Force an Electron / Chromium app to expose its accessibility tree.
///
/// By default Electron apps build an empty/collapsed AX tree until another
/// process flips one of two attributes on their AXApplication element. We try
/// both attribute names (older Electron uses `AXEnhancedUserInterface`, newer
/// ones look for `AXManualAccessibility`). The call is idempotent and cheap —
/// safe to invoke for native AppKit apps too (they'll just ignore it).
///
/// Call this once per pid the first time you encounter that pid in pick mode;
/// the side-effect persists for the lifetime of the target process.
pub fn wake_app_ax(pid: i32) {
    if pid <= 0 {
        return;
    }
    let app: AXUIElementRef = unsafe { AXUIElementCreateApplication(pid) };
    if app.is_null() {
        return;
    }
    let true_ref = unsafe { kCFBooleanTrue as CFTypeRef };
    for attr_name in &["AXEnhancedUserInterface", "AXManualAccessibility"] {
        let key = CFString::new(attr_name);
        let _ = unsafe { AXUIElementSetAttributeValue(app, key.as_concrete_TypeRef(), true_ref) };
    }
    unsafe { CFRelease(app as *const _) };
}

pub fn element_at(point: ScreenPoint) -> Option<AxElement> {
    let system = unsafe { AXUIElementCreateSystemWide() };
    let mut out: AXUIElementRef = std::ptr::null();
    let err =
        unsafe { AXUIElementCopyElementAtPosition(system, point.x as f32, point.y as f32, &mut out) };
    unsafe { CFRelease(system as *const _) };
    if err != K_AX_ERROR_SUCCESS || out.is_null() {
        None
    } else {
        Some(AxElement(out))
    }
}

// --- CGWindowList-based "skip our own process" hit-test ----------------------

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGWindowListCopyWindowInfo(
        option: u32,
        relative_to_window: u32,
    ) -> *const c_void;
}

const K_CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY: u32 = 1 << 0;
const K_CG_NULL_WINDOW_ID: u32 = 0;

use core_foundation::dictionary::CFDictionaryRef;
use core_foundation::number::CFNumberRef;

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFDictionaryGetValue(theDict: CFDictionaryRef, key: *const c_void) -> *const c_void;
    fn CFNumberGetValue(number: CFNumberRef, the_type: i32, value_ptr: *mut c_void) -> bool;
}

// CFNumberType: kCFNumberCGFloatType=16, kCFNumberDoubleType=13, kCFNumberSInt32Type=3
const K_CF_NUMBER_SINT32: i32 = 3;
const K_CF_NUMBER_DOUBLE: i32 = 13;

fn cf_dict_get(dict: CFDictionaryRef, key: &str) -> *const c_void {
    let cf_key = CFString::new(key);
    unsafe { CFDictionaryGetValue(dict, cf_key.as_concrete_TypeRef() as *const c_void) }
}

fn read_i32(dict: CFDictionaryRef, key: &str) -> Option<i32> {
    let v = cf_dict_get(dict, key);
    if v.is_null() {
        return None;
    }
    let mut out: i32 = 0;
    let ok = unsafe { CFNumberGetValue(v as CFNumberRef, K_CF_NUMBER_SINT32, &mut out as *mut i32 as *mut c_void) };
    if ok { Some(out) } else { None }
}

fn read_f64(dict: CFDictionaryRef, key: &str) -> Option<f64> {
    let v = cf_dict_get(dict, key);
    if v.is_null() {
        return None;
    }
    let mut out: f64 = 0.0;
    let ok = unsafe { CFNumberGetValue(v as CFNumberRef, K_CF_NUMBER_DOUBLE, &mut out as *mut f64 as *mut c_void) };
    if ok { Some(out) } else { None }
}

/// Find the topmost on-screen window at `point` whose owner process is NOT
/// `skip_pid`. Returns the owning pid + window bounds. Used to bypass our own
/// overlay window when AX-hit-testing.
pub fn topmost_window_owner_at(point: ScreenPoint, skip_pid: i32) -> Option<(i32, ScreenRect)> {
    let info_ref: *const c_void = unsafe {
        CGWindowListCopyWindowInfo(K_CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY, K_CG_NULL_WINDOW_ID)
    };
    if info_ref.is_null() {
        return None;
    }
    let array: CFArray<*const c_void> = unsafe { CFArray::wrap_under_create_rule(info_ref as _) };
    for i in 0..array.len() {
        let item = array.get(i).map(|r| *r).unwrap_or(std::ptr::null());
        if item.is_null() {
            continue;
        }
        let dict = item as CFDictionaryRef;
        let Some(owner) = read_i32(dict, "kCGWindowOwnerPID") else { continue };
        if owner == skip_pid || owner <= 0 {
            continue;
        }
        // Read window bounds — keys: X, Y, Width, Height (CFNumber doubles).
        let bounds_ref = cf_dict_get(dict, "kCGWindowBounds");
        if bounds_ref.is_null() {
            continue;
        }
        let b = bounds_ref as CFDictionaryRef;
        let x = read_f64(b, "X").unwrap_or(0.0);
        let y = read_f64(b, "Y").unwrap_or(0.0);
        let w = read_f64(b, "Width").unwrap_or(0.0);
        let h = read_f64(b, "Height").unwrap_or(0.0);
        if w <= 1.0 || h <= 1.0 {
            continue;
        }
        let contains = point.x >= x && point.x <= x + w && point.y >= y && point.y <= y + h;
        if contains {
            // Skip the system-wide menubar/Dock processes only if their window
            // doesn't actually contain the cursor — but since we checked above,
            // we accept this as the answer.
            return Some((owner, ScreenRect { x, y, w, h }));
        }
    }
    None
}

/// Hit-test that explicitly skips windows owned by `skip_pid` (i.e. ours).
/// Returns the deepest AX element in the topmost other app at the point.
pub fn element_at_excluding(point: ScreenPoint, skip_pid: i32) -> Option<AxElement> {
    let (target_pid, _bounds) = topmost_window_owner_at(point, skip_pid)?;
    let app: AXUIElementRef = unsafe { AXUIElementCreateApplication(target_pid) };
    if app.is_null() {
        return None;
    }
    let mut out: AXUIElementRef = std::ptr::null();
    let err = unsafe { AXUIElementCopyElementAtPosition(app, point.x as f32, point.y as f32, &mut out) };
    unsafe { CFRelease(app as *const _) };
    if err != K_AX_ERROR_SUCCESS || out.is_null() {
        None
    } else {
        Some(AxElement(out))
    }
}

/// Get the pid of the system's currently-focused (frontmost) application
/// via `AXFocusedApplication` on the system-wide AX root. This bypasses
/// CGWindowList entirely and gives us the *real* main process pid that owns
/// the user's attention — for Electron apps that's the main process, not a
/// helper / renderer subprocess.
pub fn frontmost_app_pid() -> Option<i32> {
    let system = unsafe { AXUIElementCreateSystemWide() };
    if system.is_null() {
        return None;
    }
    let key = CFString::new("AXFocusedApplication");
    let mut app: CFTypeRef = std::ptr::null();
    let err = unsafe { AXUIElementCopyAttributeValue(system, key.as_concrete_TypeRef(), &mut app) };
    unsafe { CFRelease(system as *const _) };
    if err != K_AX_ERROR_SUCCESS || app.is_null() {
        return None;
    }
    let mut pid: i32 = -1;
    let perr = unsafe { AXUIElementGetPid(app as AXUIElementRef, &mut pid) };
    unsafe { CFRelease(app) };
    if perr != K_AX_ERROR_SUCCESS || pid <= 0 {
        return None;
    }
    Some(pid)
}

/// Hit-test inside a specific app's AX tree. Used when we already know which
/// app the user is interacting with (e.g. from `frontmost_app_pid`).
pub fn element_at_in_app(point: ScreenPoint, app_pid: i32) -> Option<AxElement> {
    let app: AXUIElementRef = unsafe { AXUIElementCreateApplication(app_pid) };
    if app.is_null() {
        return None;
    }
    let mut out: AXUIElementRef = std::ptr::null();
    let err = unsafe { AXUIElementCopyElementAtPosition(app, point.x as f32, point.y as f32, &mut out) };
    unsafe { CFRelease(app as *const _) };
    if err != K_AX_ERROR_SUCCESS || out.is_null() {
        None
    } else {
        Some(AxElement(out))
    }
}

/// Full pick using a known app pid: hit-test in that app, deepen, build a
/// `PickedElement`. Bypasses CGWindowList entirely so Electron's helper-pid
/// confusion is moot.
pub fn pick_in_app(point: ScreenPoint, app_pid: i32) -> Result<PickedElement> {
    if !check_permission(false) {
        bail!("AX permission denied");
    }
    // Wake the app (idempotent — no-op for non-Electron).
    wake_app_ax(app_pid);
    let initial = element_at_in_app(point, app_pid)
        .ok_or_else(|| anyhow!("no AX element at ({},{}) in app pid {}", point.x, point.y, app_pid))?;
    let el = deepen_at(initial, point);
    let role = el.str_attr("AXRole").unwrap_or_else(|| "AXUnknown".into());
    let subrole = el.str_attr("AXSubrole").filter(|s| !s.is_empty());
    let name = el
        .str_attr("AXTitle")
        .or_else(|| el.str_attr("AXDescription"))
        .or_else(|| el.str_attr("AXLabel"))
        .or_else(|| el.str_attr("AXValue"))
        .unwrap_or_default();
    let identifier = el.str_attr("AXIdentifier").filter(|s| !s.is_empty());
    let bounds = el
        .rect()
        .ok_or_else(|| anyhow!("picked element has no bounds"))?;
    let (window_title, window_bounds) = match el.enclosing_window() {
        Some(w) => (w.str_attr("AXTitle"), w.rect()),
        None => (None, None),
    };
    let app_path = pid_to_path(app_pid);
    Ok(PickedElement {
        role,
        subrole,
        name,
        identifier,
        bounds,
        pid: app_pid,
        app_path,
        window_title,
        window_bounds,
    })
}

/// After an initial hit-test, walk the element's children to find the deepest
/// child whose bounds contain `point`. Necessary because Electron / Chromium
/// apps return shallow `AXWebArea` containers from the system-wide hit-test;
/// real leaf elements (buttons, message bubbles, text) are nested children we
/// have to descend into manually.
///
/// A no-op for native AppKit apps (their initial hit-test already returns the
/// leaf — child walk finds nothing more specific).
pub fn deepen_at(start: AxElement, point: ScreenPoint) -> AxElement {
    let mut current = start;
    for _ in 0..40 {
        // Try several children attributes — Electron / Chromium AX trees
        // sometimes hide content under AXContents rather than AXChildren.
        let kids = {
            let v = current.array_attr("AXVisibleChildren");
            if !v.is_empty() {
                v
            } else {
                let c = current.array_attr("AXChildren");
                if !c.is_empty() {
                    c
                } else {
                    current.array_attr("AXContents")
                }
            }
        };
        // Find the child whose bounds tightly contain the point. If multiple
        // children match (e.g. overlapping), pick the smallest-area one — that
        // generally corresponds to the most specific leaf.
        let mut best: Option<(AxElement, f64)> = None;
        for k in kids {
            let Some(rect) = k.rect() else { continue };
            let contains = point.x >= rect.x
                && point.x <= rect.x + rect.w
                && point.y >= rect.y
                && point.y <= rect.y + rect.h;
            if !contains {
                continue;
            }
            let area = rect.w * rect.h;
            if best.as_ref().map(|(_, a)| area < *a).unwrap_or(true) {
                best = Some((k, area));
            }
        }
        match best {
            Some((deeper, _)) => current = deeper,
            None => return current,
        }
    }
    current
}

/// Hit-test at `point`, walk to enclosing window, capture metadata.
///
/// Excludes the calling process from the hit-test (so e.g. our own overlay
/// window doesn't return its own AXWebArea when the user hovers above another
/// app's window).
pub fn pick(point: ScreenPoint) -> Result<PickedElement> {
    if !check_permission(false) {
        bail!("AX permission denied — grant Accessibility access in System Settings then retry.");
    }
    let our_pid = std::process::id() as i32;
    let initial = element_at_excluding(point, our_pid)
        .or_else(|| element_at(point))
        .ok_or_else(|| anyhow!("no AX element at ({}, {})", point.x, point.y))?;
    let el = deepen_at(initial, point);
    let role = el.str_attr("AXRole").unwrap_or_else(|| "AXUnknown".into());
    let subrole = el.str_attr("AXSubrole").filter(|s| !s.is_empty());
    let name = el
        .str_attr("AXTitle")
        .or_else(|| el.str_attr("AXDescription"))
        .or_else(|| el.str_attr("AXLabel"))
        .or_else(|| el.str_attr("AXValue"))
        .unwrap_or_default();
    let identifier = el.str_attr("AXIdentifier").filter(|s| !s.is_empty());
    let bounds = el
        .rect()
        .ok_or_else(|| anyhow!("element has no bounds"))?;
    let pid = el.pid().unwrap_or(-1);

    let (window_title, window_bounds) = match el.enclosing_window() {
        Some(w) => (w.str_attr("AXTitle"), w.rect()),
        None => (None, None),
    };

    // Look up the process path via /proc-equivalent on macOS (libproc).
    let app_path = pid_to_path(pid);

    Ok(PickedElement {
        role,
        subrole,
        name,
        identifier,
        bounds,
        pid,
        app_path,
        window_title,
        window_bounds,
    })
}

extern "C" {
    fn proc_pidpath(pid: i32, buffer: *mut c_void, buffersize: u32) -> i32;
}

const PROC_PIDPATHINFO_MAXSIZE: usize = 4 * 1024;

fn pid_to_path(pid: i32) -> Option<String> {
    if pid <= 0 {
        return None;
    }
    let mut buf: Vec<u8> = vec![0; PROC_PIDPATHINFO_MAXSIZE];
    let n = unsafe { proc_pidpath(pid, buf.as_mut_ptr() as *mut c_void, PROC_PIDPATHINFO_MAXSIZE as u32) };
    if n <= 0 {
        return None;
    }
    buf.truncate(n as usize);
    String::from_utf8(buf).ok()
}

// --- Subtree walk ------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Node {
    pub role: String,
    pub subrole: Option<String>,
    pub name: String,
    pub identifier: Option<String>,
    pub value: Option<String>,
    pub role_description: Option<String>,
    pub bounds: Option<ScreenRect>,
    /// Filled in by the sampling pass.
    pub bg: Option<(u8, u8, u8)>,
    pub children: Vec<Node>,
}

pub fn walk_subtree(point: ScreenPoint, max_depth: u32) -> Result<Node> {
    let root = element_at(point).ok_or_else(|| anyhow!("no AX element at point"))?;
    Ok(capture_node(&root, 0, max_depth))
}

pub fn walk_node(el: &AxElement, max_depth: u32) -> Node {
    capture_node(el, 0, max_depth)
}

fn capture_node(el: &AxElement, depth: u32, max_depth: u32) -> Node {
    let role = el.str_attr("AXRole").unwrap_or_else(|| "AXUnknown".into());
    let subrole = el.str_attr("AXSubrole").filter(|s| !s.is_empty());
    let name = el
        .str_attr("AXTitle")
        .or_else(|| el.str_attr("AXDescription"))
        .or_else(|| el.str_attr("AXLabel"))
        .or_else(|| el.str_attr("AXValue"))
        .unwrap_or_default();
    let identifier = el.str_attr("AXIdentifier").filter(|s| !s.is_empty());
    let value = el
        .str_attr("AXValue")
        .filter(|s| !s.is_empty() && Some(s) != Some(&name));
    let role_description = el
        .str_attr("AXRoleDescription")
        .filter(|s| !s.is_empty());
    let bounds = el.rect();

    let mut children = Vec::new();
    if depth < max_depth {
        let kids = {
            let visible = el.array_attr("AXVisibleChildren");
            if !visible.is_empty() {
                visible
            } else {
                el.array_attr("AXChildren")
            }
        };
        for kid in &kids {
            children.push(capture_node(kid, depth + 1, max_depth));
        }
    }

    Node {
        role,
        subrole,
        name,
        identifier,
        value,
        role_description,
        bounds,
        bg: None,
        children,
    }
}

pub fn count_nodes(n: &Node) -> usize {
    1 + n.children.iter().map(count_nodes).sum::<usize>()
}
