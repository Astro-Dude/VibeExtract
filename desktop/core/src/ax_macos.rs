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
const K_AX_VALUE_TYPE_CG_RECT: u32 = 3;
// AXUIElementCopyMultipleAttributeValues options: 0 = unsupported/missing
// attributes come back per-slot (as AXValue(kAXValueTypeAXError) or kCFNull)
// instead of failing the whole call — exactly what the name-fallback wants.
const K_AX_COPY_MULTIPLE_NO_OPTIONS: u32 = 0;

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
    fn AXValueGetTypeID() -> usize;
    /// One Mach round-trip for N attributes (vs N round-trips of
    /// AXUIElementCopyAttributeValue) — the extraction walk's hot path.
    fn AXUIElementCopyMultipleAttributeValues(
        element: AXUIElementRef,
        attributes: CFArrayRef,
        options: u32,
        values: *mut CFArrayRef,
    ) -> AXError;
    /// Set on the system-wide element this changes the GLOBAL reply timeout
    /// for every AX message this process sends — a hung/busy target app then
    /// fails fast instead of stalling each attribute read at the ~6s default.
    fn AXUIElementSetMessagingTimeout(element: AXUIElementRef, timeout_seconds: f32) -> AXError;
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
    /// Identity hash for walk-time dedup: two AXUIElementRefs for the same
    /// on-screen element hash (and compare) equal even when the pointers
    /// differ.
    fn CFHash(cf: *const c_void) -> usize;
    fn CFBooleanGetTypeID() -> usize;
    fn CFBooleanGetValue(boolean: *const c_void) -> bool;
    fn CFNumberGetTypeID() -> usize;
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

    /// Identity hash (CFHash) — equal for two refs to the same element, used
    /// to dedupe merged child relations and to break walk cycles.
    pub fn id_hash(&self) -> usize {
        unsafe { CFHash(self.0) }
    }

    pub fn rect(&self) -> Option<ScreenRect> {
        // AXFrame is one attribute read + decode where position+size is two.
        // Not every app implements it, so fall back to the classic pair.
        if let Some(r) = self.frame_attr("AXFrame") {
            return Some(r);
        }
        let pt = self.point_attr("AXPosition")?;
        let (w, h) = self.size_attr("AXSize")?;
        Some(ScreenRect {
            x: pt.x,
            y: pt.y,
            w,
            h,
        })
    }

    fn frame_attr(&self, key: &str) -> Option<ScreenRect> {
        #[repr(C)]
        struct CGRectFFI {
            x: f64,
            y: f64,
            w: f64,
            h: f64,
        }
        let key_cf = CFString::new(key);
        let mut value: CFTypeRef = std::ptr::null();
        let err =
            unsafe { AXUIElementCopyAttributeValue(self.0, key_cf.as_concrete_TypeRef(), &mut value) };
        if err != K_AX_ERROR_SUCCESS || value.is_null() {
            return None;
        }
        if unsafe { CFGetTypeID(value) } != unsafe { AXValueGetTypeID() }
            || unsafe { AXValueGetType(value as AXValueRef) } != K_AX_VALUE_TYPE_CG_RECT
        {
            unsafe { CFRelease(value) };
            return None;
        }
        let mut r = CGRectFFI { x: 0.0, y: 0.0, w: 0.0, h: 0.0 };
        let ok = unsafe {
            AXValueGetValue(
                value as AXValueRef,
                K_AX_VALUE_TYPE_CG_RECT,
                &mut r as *mut CGRectFFI as *mut c_void,
            )
        };
        unsafe { CFRelease(value) };
        ok.then(|| ScreenRect { x: r.x, y: r.y, w: r.w, h: r.h })
    }

    /// Fetch all node attributes the extraction walk needs in ONE Mach IPC
    /// round-trip via `AXUIElementCopyMultipleAttributeValues` (the
    /// per-attribute path costs 8–10 round-trips per node, which dominates
    /// extraction latency on big trees). Returns `None` when the batch call
    /// itself fails (dead element, app without the multi-attribute API) —
    /// the caller falls back to the per-attribute path so behaviour never
    /// regresses.
    pub fn batch_node_attrs(&self) -> Option<NodeAttrs> {
        const NODE_ATTRS: [&str; 16] = [
            "AXRole",
            "AXSubrole",
            "AXTitle",
            "AXDescription",
            "AXLabel",
            "AXValue",
            "AXIdentifier",
            "AXRoleDescription",
            "AXPosition",
            "AXSize",
            // UI-state flags the replica must mirror (selected tab, disabled
            // button, focused field, expanded row). Same batch, zero extra IPC.
            "AXFocused",
            "AXSelected",
            "AXEnabled",
            "AXExpanded",
            // Range endpoints for sliders / progress bars / scroll bars.
            "AXMinValue",
            "AXMaxValue",
        ];
        let keys: Vec<CFString> = NODE_ATTRS.iter().map(|k| CFString::new(k)).collect();
        let keys_arr = CFArray::from_CFTypes(&keys);
        let mut values: CFArrayRef = std::ptr::null();
        let err = unsafe {
            AXUIElementCopyMultipleAttributeValues(
                self.0,
                keys_arr.as_concrete_TypeRef(),
                K_AX_COPY_MULTIPLE_NO_OPTIONS,
                &mut values,
            )
        };
        if err != K_AX_ERROR_SUCCESS || values.is_null() {
            return None;
        }
        // Copy rule: WE own the returned array — wrap under the create rule so
        // it's released exactly once on drop. Its ELEMENTS are +0 borrows owned
        // by the array: never CFRelease them; the decoders retain (get rule)
        // only what they keep.
        let arr = unsafe { CFArray::<*const c_void>::wrap_under_create_rule(values) };
        if arr.len() as usize != NODE_ATTRS.len() {
            return None; // defensive: result must align 1:1 with the input order
        }
        let get = |i: isize| -> *const c_void { arr.get(i).map(|r| *r).unwrap_or(std::ptr::null()) };
        Some(NodeAttrs {
            role: cf_to_string(get(0)),
            subrole: cf_to_string(get(1)),
            title: cf_to_string(get(2)),
            description: cf_to_string(get(3)),
            label: cf_to_string(get(4)),
            value: cf_to_value_string(get(5)),
            identifier: cf_to_string(get(6)),
            role_description: cf_to_string(get(7)),
            position: cf_to_point(get(8)),
            size: cf_to_size(get(9)),
            focused: cf_to_bool(get(10)),
            selected: cf_to_bool(get(11)),
            enabled: cf_to_bool(get(12)),
            expanded: cf_to_bool(get(13)),
            min_value: cf_to_f64(get(14)),
            max_value: cf_to_f64(get(15)),
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

    /// Number of immediate AX children (AXChildren, falling back to AXContents
    /// the way `deepen_at` does). A cheap "is this subtree rich?" signal:
    /// Electron's window-filling shallow containers report ~0 (web content isn't
    /// in AX), whereas a native window-sized group (e.g. Calendar's "Year
    /// Calendar Area") reports many. Used by `is_shallow_pick` so a legitimate
    /// native container isn't mistaken for an empty Electron placeholder.
    pub fn child_count(&self) -> usize {
        let n = self.array_attr("AXChildren").len();
        if n > 0 { n } else { self.array_attr("AXContents").len() }
    }

    /// Return this element's immediate parent via AXParent, or None at the
    /// top of the AX tree (e.g. on AXApplication). Caller owns the returned
    /// element.
    pub fn parent(&self) -> Option<AxElement> {
        let key_cf = CFString::new("AXParent");
        let mut parent: CFTypeRef = std::ptr::null();
        let err = unsafe {
            AXUIElementCopyAttributeValue(self.0, key_cf.as_concrete_TypeRef(), &mut parent)
        };
        if err != K_AX_ERROR_SUCCESS || parent.is_null() {
            return None;
        }
        Some(AxElement(parent as AXUIElementRef))
    }

    /// Copy an attribute that is itself an AX element (e.g. `AXMainWindow`,
    /// `AXFocusedWindow`). Caller owns the returned element (released on drop).
    pub fn element_attr(&self, key: &str) -> Option<AxElement> {
        let key_cf = CFString::new(key);
        let mut out: CFTypeRef = std::ptr::null();
        let err =
            unsafe { AXUIElementCopyAttributeValue(self.0, key_cf.as_concrete_TypeRef(), &mut out) };
        if err != K_AX_ERROR_SUCCESS || out.is_null() {
            return None;
        }
        Some(AxElement(out as AXUIElementRef))
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

/// All node attributes the extraction walk consumes, fetched in one batched
/// IPC by [`AxElement::batch_node_attrs`].
pub struct NodeAttrs {
    pub role: Option<String>,
    pub subrole: Option<String>,
    pub title: Option<String>,
    pub description: Option<String>,
    pub label: Option<String>,
    pub value: Option<String>,
    pub identifier: Option<String>,
    pub role_description: Option<String>,
    pub position: Option<ScreenPoint>,
    pub size: Option<(f64, f64)>,
    pub focused: Option<bool>,
    pub selected: Option<bool>,
    pub enabled: Option<bool>,
    pub expanded: Option<bool>,
    pub min_value: Option<f64>,
    pub max_value: Option<f64>,
}

// Slot decoders for the batched result array. All take +0 borrows (the array
// owns each element and releases it when the array drops) — so unlike
// `str_attr`/`point_attr`/`size_attr`, they must NOT CFRelease. Missing or
// unsupported attributes arrive as AXValue(kAXValueTypeAXError) or kCFNull;
// both fail the type gates below and decode to None — matching the
// per-attribute helpers' "unexpected type means None" semantics.

fn cf_to_string(v: *const c_void) -> Option<String> {
    if v.is_null() {
        return None;
    }
    if unsafe { CFGetTypeID(v) } != CFString::type_id() {
        return None;
    }
    // wrap_under_get_rule RETAINS — required: the array owns v.
    Some(unsafe { CFString::wrap_under_get_rule(v as CFStringRef) }.to_string())
}

fn cf_to_point(v: *const c_void) -> Option<ScreenPoint> {
    if v.is_null() || unsafe { CFGetTypeID(v) } != unsafe { AXValueGetTypeID() } {
        return None;
    }
    if unsafe { AXValueGetType(v as AXValueRef) } != K_AX_VALUE_TYPE_CG_POINT {
        return None; // also rejects AXValue(kAXValueTypeAXError) slots
    }
    let mut pt = CGPoint { x: 0.0, y: 0.0 };
    let ok = unsafe {
        AXValueGetValue(
            v as AXValueRef,
            K_AX_VALUE_TYPE_CG_POINT,
            &mut pt as *mut CGPoint as *mut c_void,
        )
    };
    ok.then(|| ScreenPoint { x: pt.x, y: pt.y })
}

fn cf_to_size(v: *const c_void) -> Option<(f64, f64)> {
    #[repr(C)]
    struct CGSize {
        width: f64,
        height: f64,
    }
    if v.is_null() || unsafe { CFGetTypeID(v) } != unsafe { AXValueGetTypeID() } {
        return None;
    }
    if unsafe { AXValueGetType(v as AXValueRef) } != K_AX_VALUE_TYPE_CG_SIZE {
        return None;
    }
    let mut sz = CGSize { width: 0.0, height: 0.0 };
    let ok = unsafe {
        AXValueGetValue(
            v as AXValueRef,
            K_AX_VALUE_TYPE_CG_SIZE,
            &mut sz as *mut CGSize as *mut c_void,
        )
    };
    ok.then(|| (sz.width, sz.height))
}

fn cf_to_bool(v: *const c_void) -> Option<bool> {
    if v.is_null() || unsafe { CFGetTypeID(v) } != unsafe { CFBooleanGetTypeID() } {
        return None;
    }
    Some(unsafe { CFBooleanGetValue(v) })
}

fn cf_to_f64(v: *const c_void) -> Option<f64> {
    if v.is_null() || unsafe { CFGetTypeID(v) } != unsafe { CFNumberGetTypeID() } {
        return None;
    }
    let mut out: f64 = 0.0;
    let ok = unsafe {
        CFNumberGetValue(v as CFNumberRef, K_CF_NUMBER_DOUBLE, &mut out as *mut f64 as *mut c_void)
    };
    ok.then_some(out)
}

/// AXValue arrives as CFString for text, but as CFNumber for checkboxes /
/// sliders / steppers and CFBoolean for toggles. `cf_to_string` silently
/// dropped those (checkbox state was simply absent from the tree); stringify
/// them instead so the replica can render the control's real state.
fn cf_to_value_string(v: *const c_void) -> Option<String> {
    if let Some(s) = cf_to_string(v) {
        return Some(s);
    }
    if let Some(b) = cf_to_bool(v) {
        return Some(if b { "1".into() } else { "0".into() });
    }
    if let Some(n) = cf_to_f64(v) {
        if n.is_finite() && n == n.trunc() {
            return Some(format!("{}", n as i64));
        }
        return Some(format!("{n}"));
    }
    None
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
/// Cap how long any single AX message may block waiting for the target app.
/// Set once on the system-wide element, which makes it the process-global
/// reply timeout — without it every attribute read on a hung/busy app stalls
/// at the ~6s system default, turning one slow target into a frozen walk.
pub fn set_ax_messaging_timeout() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let system = unsafe { AXUIElementCreateSystemWide() };
        if system.is_null() {
            return;
        }
        unsafe {
            AXUIElementSetMessagingTimeout(system, 2.0);
            CFRelease(system as *const _);
        }
    });
}

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
    set_ax_messaging_timeout();
    if !check_permission(false) {
        bail!("AX permission denied");
    }
    // Wake the app (idempotent — no-op for non-Electron).
    wake_app_ax(app_pid);
    let initial = element_at_in_app(point, app_pid)
        .ok_or_else(|| anyhow!("no AX element at ({},{}) in app pid {}", point.x, point.y, app_pid))?;
    let mut el = deepen_at(initial, point);
    // The position API sometimes lands on a shallow container (menu bar, the
    // whole window) even though the app's published tree has a real element
    // under the cursor. Before giving up, resolve by walking the tree itself;
    // keep the original element when the resolver can't do better (Electron's
    // AX-opaque web content stays shallow on purpose — the CDP ladder owns it).
    {
        let role = el.str_attr("AXRole").unwrap_or_default();
        let win = el.enclosing_window().and_then(|w| w.rect());
        let shallow = match el.rect() {
            Some(b) => is_shallow_pick(&role, &b, point, win.as_ref(), el.child_count()),
            None => true,
        };
        if shallow {
            if let Some(deep) = resolve_at_point(app_pid, point) {
                let drole = deep.str_attr("AXRole").unwrap_or_default();
                if let Some(db) = deep.rect() {
                    let dwin = deep.enclosing_window().and_then(|w| w.rect());
                    if !is_shallow_pick(&drole, &db, point, dwin.as_ref(), deep.child_count()) {
                        el = deep;
                    }
                }
            }
        }
    }
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
    let ax_shallow = is_shallow_pick(&role, &bounds, point, window_bounds.as_ref(), el.child_count());
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
        click: Some(point),
        ax_shallow,
        crop_path: None,
        ax_tree: None,
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
        // Try several children attributes — Electron / Chromium AX trees and
        // tables/outlines hide content under AXContents / AXRows / AXSections
        // rather than AXChildren. Shared with `capture_node` so the picker
        // descends as deeply as the tree walk does.
        let role = current.str_attr("AXRole").unwrap_or_default();
        let (kids, _) = enumerate_children(&current, &role);
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

/// Hit-test by walking the app's AX tree from its root and returning the
/// DEEPEST element whose frame contains `point` — a fallback for when
/// `AXUIElementCopyElementAtPosition` returns a shallow container. The
/// position API routes web-content hits through WebKit/Chromium's remote AX
/// surface (or just returns the menu bar / window), while the tree walk stays
/// on the host process's published tree — the same elements `walk_node` sees.
///
/// Tiebreak when several elements contain the point: deeper wins; equal depth
/// → smaller area; equal area → non-container roles beat plain containers.
/// Budgeted so a pathological tree can't stall the pick.
pub fn resolve_at_point(pid: i32, point: ScreenPoint) -> Option<AxElement> {
    const RESOLVE_BUDGET: usize = 20_000;
    let app = app_element(pid).ok()?;

    struct Best {
        el: AxElement,
        depth: u32,
        area: f64,
        is_container: bool,
    }
    fn is_container_role(role: &str) -> bool {
        matches!(role, "AXGroup" | "AXSplitGroup" | "AXScrollArea" | "AXLayoutArea")
    }

    let mut best: Option<Best> = None;
    let mut budget = RESOLVE_BUDGET;
    let mut visited: std::collections::HashSet<usize> = std::collections::HashSet::new();

    fn visit(
        el: AxElement,
        depth: u32,
        point: ScreenPoint,
        budget: &mut usize,
        visited: &mut std::collections::HashSet<usize>,
        best: &mut Option<Best>,
    ) {
        if *budget == 0 {
            return;
        }
        *budget -= 1;
        if !visited.insert(el.id_hash()) {
            return;
        }
        let role = el.str_attr("AXRole").unwrap_or_default();
        if let Some(r) = el.rect() {
            if r.contains(point) {
                let area = r.w * r.h;
                let is_container = is_container_role(&role);
                let better = match best.as_ref() {
                    None => true,
                    Some(b) => {
                        if depth != b.depth {
                            depth > b.depth
                        } else if area != b.area {
                            area < b.area
                        } else {
                            !is_container && b.is_container
                        }
                    }
                };
                if better {
                    // Keep our own retained ref; el continues into the walk.
                    unsafe { CFRetain(el.0 as *const _) };
                    *best = Some(Best { el: AxElement(el.0), depth, area, is_container });
                }
            }
        }
        let (kids, _) = enumerate_children(&el, &role);
        for k in kids {
            visit(k, depth + 1, point, budget, visited, best);
        }
    }

    // Start at the app root (catches menu bar / status items reachable only
    // there), then sweep the explicit window collections for apps that publish
    // AXWindows but not AXChildren. The visited set makes the overlap free.
    visit(app, 0, point, &mut budget, &mut visited, &mut best);
    if let Ok(app2) = app_element(pid) {
        for w in app2.array_attr("AXWindows") {
            visit(w, 0, point, &mut budget, &mut visited, &mut best);
        }
        for key in ["AXMainWindow", "AXFocusedWindow"] {
            if let Some(w) = app2.element_attr(key) {
                visit(w, 0, point, &mut budget, &mut visited, &mut best);
            }
        }
    }
    best.map(|b| b.el)
}

/// Heuristic: did the AX hit-test fail to land on a real content element the
/// user could have meant? True when the resolved element can't be the click
/// target — its bounds don't contain the click, or it's a top-level container
/// (menu bar / application / whole window) that Electron returns when its web
/// content isn't exposed to AX (so `AXUIElementCopyElementAtPosition` yields the
/// `AXMenuBar` at `{0,0,W,30}` instead of the clicked sidebar/message). Such a
/// result must NOT be committed as the pick: the caller keeps the click point
/// and re-resolves at it via the CDP ladder.
/// A window-filling element is treated as shallow only when it has at most this
/// many AX children — the Electron signature (one big empty container because web
/// content isn't exposed to AX). A native window-sized group has far more, so it
/// stays a real, selectable element.
const SHALLOW_MAX_CHILDREN: usize = 2;

pub fn is_shallow_pick(
    role: &str,
    bounds: &ScreenRect,
    click: ScreenPoint,
    window_bounds: Option<&ScreenRect>,
    child_count: usize,
) -> bool {
    // The element doesn't even cover where the user clicked.
    if !bounds.contains(click) {
        return true;
    }
    // Top-level containers are never the intended target of a content click.
    if matches!(
        role,
        "AXMenuBar" | "AXMenuBarItem" | "AXApplication" | "AXWindow"
    ) {
        return true;
    }
    // The element is ~the whole window. This is shallow ONLY when it also has
    // almost no AX children — i.e. Electron returned a big empty container
    // because its web content isn't in the AX tree. A NATIVE app's window-sized
    // group (e.g. Calendar's "Year Calendar Area", which holds the 12 month
    // grids) is rich and IS a legitimate pick — don't shrink it to a click box.
    if let Some(win) = window_bounds {
        let win_area = win.w * win.h;
        let el_area = bounds.w * bounds.h;
        if win_area > 0.0 && el_area >= 0.9 * win_area && child_count <= SHALLOW_MAX_CHILDREN {
            return true;
        }
    }
    false
}

/// Hit-test at `point`, walk to enclosing window, capture metadata.
///
/// Excludes the calling process from the hit-test (so e.g. our own overlay
/// window doesn't return its own AXWebArea when the user hovers above another
/// app's window).
pub fn pick(point: ScreenPoint) -> Result<PickedElement> {
    set_ax_messaging_timeout();
    if !check_permission(false) {
        bail!("AX permission denied — grant Accessibility access in System Settings then retry.");
    }
    let our_pid = std::process::id() as i32;
    let initial = element_at_excluding(point, our_pid)
        .or_else(|| element_at(point))
        .ok_or_else(|| anyhow!("no AX element at ({}, {})", point.x, point.y))?;
    let mut el = deepen_at(initial, point);
    // Same shallow-pick rescue as `pick_in_app`: when the position API lands
    // on a menu bar / whole-window container, walk the app's own tree for the
    // deepest element under the cursor before committing the shallow result.
    if let Some(el_pid) = el.pid() {
        let role = el.str_attr("AXRole").unwrap_or_default();
        let win = el.enclosing_window().and_then(|w| w.rect());
        let shallow = match el.rect() {
            Some(b) => is_shallow_pick(&role, &b, point, win.as_ref(), el.child_count()),
            None => true,
        };
        if shallow {
            if let Some(deep) = resolve_at_point(el_pid, point) {
                let drole = deep.str_attr("AXRole").unwrap_or_default();
                if let Some(db) = deep.rect() {
                    let dwin = deep.enclosing_window().and_then(|w| w.rect());
                    if !is_shallow_pick(&drole, &db, point, dwin.as_ref(), deep.child_count()) {
                        el = deep;
                    }
                }
            }
        }
    }
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
    let ax_shallow = is_shallow_pick(&role, &bounds, point, window_bounds.as_ref(), el.child_count());

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
        click: Some(point),
        ax_shallow,
        crop_path: None,
        ax_tree: None,
    })
}

extern "C" {
    fn proc_pidpath(pid: i32, buffer: *mut c_void, buffersize: u32) -> i32;
}

const PROC_PIDPATHINFO_MAXSIZE: usize = 4 * 1024;

pub fn pid_to_path(pid: i32) -> Option<String> {
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
    /// UI-state flags currently TRUE on the element: "focused", "selected",
    /// "expanded", plus "disabled" when AXEnabled is explicitly false. An
    /// absent flag means "not reported", not "false" — apps that don't
    /// implement an attribute simply don't emit it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub state: Vec<String>,
    /// Range endpoints for value-bearing roles (sliders, progress bars,
    /// scroll bars, steppers) so the replica can position the thumb/fill.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_value: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_value: Option<f64>,
    /// True when children were dropped here (per-role child cap or the
    /// global node budget) — an honest "there is more under this node".
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
    /// Which AX relation produced this node's children when it wasn't the
    /// obvious AXChildren/AXVisibleChildren — e.g. "AXRows", "AXContents",
    /// "AXSections", or an "empty:…" honesty marker for an AX-opaque web
    /// surface. `None` for the common case. Surfaces *where* structure came
    /// from (or why it's missing) instead of a mysteriously flat tree.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub child_source: Option<String>,
    pub children: Vec<Node>,
}

pub fn walk_subtree(point: ScreenPoint, max_depth: u32) -> Result<Node> {
    let root = element_at(point).ok_or_else(|| anyhow!("no AX element at point"))?;
    Ok(walk_node(&root, max_depth))
}

/// Hard ceiling on nodes per walk — a runaway-tree backstop far above any
/// real window (Desktop_Pluck uses the same figure). When hit, the node where
/// the budget ran out is flagged `truncated` instead of silently flattening.
const WALK_NODE_BUDGET: usize = 100_000;

/// Walk-shared state: cycle/dedup protection plus the node budget. AX trees
/// can alias the same element under several relations (and, rarely, cycle
/// via misbehaving apps) — `visited` guarantees each element is emitted once.
struct WalkCtx {
    visited: std::collections::HashSet<usize>,
    nodes_left: usize,
}

pub fn walk_node(el: &AxElement, max_depth: u32) -> Node {
    let mut ctx = WalkCtx {
        visited: std::collections::HashSet::new(),
        nodes_left: WALK_NODE_BUDGET,
    };
    ctx.visited.insert(el.id_hash());
    capture_node(el, 0, max_depth, &mut ctx)
}

/// Per-role cap on how many children of one node are walked. Data containers
/// get generous caps (a year calendar really has 365+ cells); leaf-ish roles
/// get tight ones (an AXButton with 500 "children" is a broken tree, not UI).
fn child_cap(role: &str) -> usize {
    match role {
        "AXOutline" | "AXTable" | "AXGrid" | "AXBrowser" => 10_000,
        "AXRow" | "AXColumn" => 5_000,
        "AXList" => 2_000,
        "AXMenu" | "AXMenuBar" | "AXMenuBarItem" => 500,
        "AXToolbar" | "AXTabGroup" | "AXSplitGroup" | "AXScrollArea" | "AXGroup" => 1_000,
        "AXButton" | "AXMenuButton" | "AXStaticText" | "AXTextField" | "AXCheckBox"
        | "AXRadioButton" | "AXImage" => 50,
        _ => 1_000,
    }
}

fn capture_node(el: &AxElement, depth: u32, max_depth: u32, ctx: &mut WalkCtx) -> Node {
    // One batched IPC for all 10 node attributes (the per-attribute path costs
    // 8–10 Mach round-trips per node — THE extraction-latency hot spot on big
    // trees). Name fallback priority is identical: Title → Description → Label
    // → Value. Falls back to the per-attribute path when the batch call fails
    // outright (dying element, app without the multi-attribute API).
    let (role, subrole, name, identifier, mut value, role_description, bounds, state, min_value, max_value) =
        match el.batch_node_attrs() {
            Some(a) => {
                let name = a
                    .title
                    .or(a.description)
                    .or(a.label)
                    .or_else(|| a.value.clone())
                    .unwrap_or_default();
                let value = a.value.filter(|s| !s.is_empty() && *s != name);
                let bounds = match (a.position, a.size) {
                    (Some(pt), Some((w, h))) => Some(ScreenRect { x: pt.x, y: pt.y, w, h }),
                    _ => None,
                };
                let mut state: Vec<String> = Vec::new();
                if a.focused == Some(true) {
                    state.push("focused".into());
                }
                if a.selected == Some(true) {
                    state.push("selected".into());
                }
                if a.expanded == Some(true) {
                    state.push("expanded".into());
                }
                if a.enabled == Some(false) {
                    state.push("disabled".into());
                }
                (
                    a.role.unwrap_or_else(|| "AXUnknown".into()),
                    a.subrole.filter(|s| !s.is_empty()),
                    name,
                    a.identifier.filter(|s| !s.is_empty()),
                    value,
                    a.role_description.filter(|s| !s.is_empty()),
                    bounds,
                    state,
                    a.min_value,
                    a.max_value,
                )
            }
            None => {
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
                (role, subrole, name, identifier, value, role_description, el.rect(), Vec::new(), None, None)
            }
        };

    // Two-state roles report a numeric AXValue — translate to the words the
    // generator actually needs ("is this checkbox on?") instead of a bare "1".
    if matches!(
        role.as_str(),
        "AXCheckBox" | "AXRadioButton" | "AXToggleButton" | "AXDisclosureTriangle"
    ) {
        value = match value.as_deref() {
            Some("0") => Some("off".into()),
            Some("1") => Some("on".into()),
            Some("2") => Some("mixed".into()),
            other => other.map(|s| s.to_string()),
        };
    }

    let mut children = Vec::new();
    let mut child_source: Option<String> = None;
    let mut truncated = false;
    if depth < max_depth {
        let (kids, rel) = enumerate_children(el, &role);
        child_source = rel;
        let cap = child_cap(&role);
        if kids.len() > cap {
            truncated = true;
        }
        for kid in kids.iter().take(cap) {
            if ctx.nodes_left == 0 {
                truncated = true;
                break;
            }
            // Emit each element once — relations alias (a row can appear under
            // both AXChildren and AXRows) and broken trees can cycle.
            if !ctx.visited.insert(kid.id_hash()) {
                continue;
            }
            ctx.nodes_left -= 1;
            children.push(capture_node(kid, depth + 1, max_depth, ctx));
        }
    }
    // Honesty marker: a web surface that exposed NO children through ANY
    // relation is Chromium/CEF content AX can't see — the real structure lives
    // in the DOM and needs CDP. Flag it so a flat tree reads as "opaque here"
    // rather than a mysterious empty leaf. (Restricted to AXWebArea; an empty
    // AXGroup is too common to be a reliable signal.)
    if children.is_empty() && depth < max_depth && role == "AXWebArea" {
        child_source = Some("empty:web-content-opaque-to-AX (needs CDP)".into());
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
        state,
        min_value,
        max_value,
        truncated,
        child_source,
        children,
    }
}

/// Enumerate an element's child elements: the standard relations first, then
/// the role-specific ones apps hide structure behind, MERGED and deduped by
/// element identity. Returns the children plus a relation note when structure
/// came from anywhere beyond the obvious AXChildren / AXVisibleChildren (so
/// `capture_node` can record where it came from).
///
/// Why merge instead of first-non-empty: an AXWindow exposes its content via
/// AXChildren AND a modal sheet only via AXSheets; a table can list columns
/// under AXChildren while the rows live only under AXRows. First-wins dropped
/// those — tables lost cells, tab groups lost tabs, windows lost sheets.
/// Dedup by `id_hash` keeps the aliased majority from double-counting.
///
/// Inner slices are ALTERNATIVES tried in order (first that contributes wins)
/// so AXVisibleRows is preferred over the potentially huge full AXRows.
fn enumerate_children(el: &AxElement, role: &str) -> (Vec<AxElement>, Option<String>) {
    let visible = el.array_attr("AXVisibleChildren");
    let mut kids = if !visible.is_empty() {
        visible
    } else {
        el.array_attr("AXChildren")
    };

    let extra: &[&[&str]] = match role {
        "AXWindow" => &[&["AXSheets"]],
        "AXTabGroup" => &[&["AXTabs"]],
        "AXSplitGroup" => &[&["AXSplitters"], &["AXContents"]],
        "AXTable" | "AXOutline" | "AXGrid" | "AXBrowser" | "AXList" => {
            &[&["AXVisibleRows", "AXRows"]]
        }
        "AXRow" => &[&["AXVisibleCells", "AXCells"]],
        _ => &[],
    };

    let mut sources: Vec<&'static str> = Vec::new();
    if !extra.is_empty() {
        let mut seen: std::collections::HashSet<usize> =
            kids.iter().map(|k| k.id_hash()).collect();
        for alternatives in extra {
            for rel in *alternatives {
                let mut contributed = false;
                for k in el.array_attr(rel) {
                    if seen.insert(k.id_hash()) {
                        kids.push(k);
                        contributed = true;
                    }
                }
                if contributed {
                    sources.push(rel);
                    break; // this alternative produced structure; skip the rest
                }
            }
        }
    }

    if !kids.is_empty() {
        let source = if sources.is_empty() {
            None
        } else {
            Some(format!("AXChildren+{}", sources.join("+")))
        };
        return (kids, source);
    }

    // Last-ditch relations some apps use INSTEAD of children entirely
    // (AXContents = scroll areas; AXRows = tables; AXSections = documents).
    for rel in ["AXContents", "AXRows", "AXSections"] {
        let fallback = el.array_attr(rel);
        if !fallback.is_empty() {
            return (fallback, Some(rel.to_string()));
        }
    }
    (Vec::new(), None)
}

pub fn count_nodes(n: &Node) -> usize {
    1 + n.children.iter().map(count_nodes).sum::<usize>()
}

/// Grow from `el` to its sibling BAND — the run of same-parent children that share
/// `current`'s horizontal row (vertical overlap with `current` AND similar height).
/// Returns the band's bounding rect + each member's subtree (depth `max_depth`, ordered
/// left-to-right) so the caller can build a synthetic group. Returns `None` when there's
/// no real band (<2 members), the band ≈ the element, or the band ≈ the parent (so it
/// never duplicates an existing ↑ step). This is what lets ↑ select "the whole toolbar
/// row" in FLAT trees — e.g. WPS, whose ribbon tabs are direct `AXWindow` children with
/// no row container, so a plain parent-walk would jump straight to the window.
pub fn sibling_band(el: &AxElement, current: &ScreenRect, max_depth: u32) -> Option<(ScreenRect, Vec<Node>)> {
    if current.w < 1.0 || current.h < 1.0 {
        return None;
    }
    let parent = el.parent()?;
    let parent_rect = parent.rect();
    let (cy0, cy1) = (current.y, current.y + current.h);
    // Same-row siblings: vertical overlap > 50% of the current height AND similar height.
    let mut kept: Vec<(f64, AxElement, ScreenRect)> = Vec::new();
    for k in parent.array_attr("AXChildren") {
        let Some(r) = k.rect() else { continue };
        if r.w < 1.0 || r.h < 1.0 {
            continue;
        }
        let overlap = (r.y + r.h).min(cy1) - r.y.max(cy0);
        let height_similar = (r.h - current.h).abs() <= current.h * 0.6;
        if overlap > current.h * 0.5 && height_similar {
            kept.push((r.x, k, r));
        }
    }
    if kept.len() < 2 {
        return None;
    }
    let minx = kept.iter().map(|(_, _, r)| r.x).fold(f64::INFINITY, f64::min);
    let miny = kept.iter().map(|(_, _, r)| r.y).fold(f64::INFINITY, f64::min);
    let maxx = kept.iter().map(|(_, _, r)| r.x + r.w).fold(f64::NEG_INFINITY, f64::max);
    let maxy = kept.iter().map(|(_, _, r)| r.y + r.h).fold(f64::NEG_INFINITY, f64::max);
    let band = ScreenRect { x: minx, y: miny, w: maxx - minx, h: maxy - miny };
    // Must be meaningfully wider than the single element …
    if band.w < current.w * 1.5 {
        return None;
    }
    // … and not essentially the whole parent (else this is just the parent step).
    if let Some(p) = parent_rect {
        let pa = p.w * p.h;
        if pa > 0.0 && band.w * band.h >= 0.9 * pa {
            return None;
        }
    }
    kept.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let nodes: Vec<Node> = kept.iter().map(|(_, k, _)| walk_node(k, max_depth)).collect();
    Some((band, nodes))
}

// --- Root walks (app / window) -----------------------------------------------
//
// `walk_subtree`/`walk_node` above start from a hit-tested point or a live
// element. The MCP server instead wants to walk from an app or window ROOT
// (no cursor involved), so Claude can inventory a whole window's AX tree.

/// How to pick which window of an app to walk.
#[derive(Debug, Clone)]
pub enum WindowSelector {
    /// Index into the app's `AXWindows` array (front-to-back order).
    Index(usize),
    /// Exact `AXTitle` match.
    Title(String),
    /// The app's main/focused window (falls back to the first window).
    Main,
    /// Match the Core Graphics window id from [`crate::windows_list::list_windows`]
    /// by reconciling its bounds against the AX windows (best-effort).
    WindowId(u32),
}

/// Build an owned `AxElement` for an application's AX root by pid.
fn app_element(pid: i32) -> Result<AxElement> {
    if pid <= 0 {
        bail!("invalid pid {pid}");
    }
    let app: AXUIElementRef = unsafe { AXUIElementCreateApplication(pid) };
    if app.is_null() {
        bail!("AXUIElementCreateApplication({pid}) returned null");
    }
    Ok(AxElement(app))
}

/// Walk the entire AX tree of an application from its root, to `max_depth`.
/// Wakes the app's AX tree first (idempotent; needed for Electron).
pub fn walk_app(pid: i32, max_depth: u32) -> Result<Node> {
    set_ax_messaging_timeout();
    if !check_permission(false) {
        bail!("AX permission denied — grant Accessibility access in System Settings then retry.");
    }
    wake_app_ax(pid);
    let app = app_element(pid)?;
    Ok(walk_node(&app, max_depth))
}

/// Walk a single window of an application, selected by [`WindowSelector`].
pub fn walk_window(pid: i32, sel: WindowSelector, max_depth: u32) -> Result<Node> {
    set_ax_messaging_timeout();
    if !check_permission(false) {
        bail!("AX permission denied — grant Accessibility access in System Settings then retry.");
    }
    wake_app_ax(pid);
    let app = app_element(pid)?;

    // Main: prefer the app's main/focused window element directly — it doesn't
    // depend on the AXWindows array being populated/ordered as expected.
    if let WindowSelector::Main = sel {
        if let Some(w) = app
            .element_attr("AXMainWindow")
            .or_else(|| app.element_attr("AXFocusedWindow"))
        {
            return Ok(walk_node(&w, max_depth));
        }
    }

    let windows = app.array_attr("AXWindows");
    if windows.is_empty() {
        bail!("app pid {pid} exposes no AX windows (Electron may need waking, or none are open)");
    }

    let idx = match sel {
        WindowSelector::Index(i) => i,
        WindowSelector::Main => 0,
        WindowSelector::Title(t) => windows
            .iter()
            .position(|w| w.str_attr("AXTitle").as_deref() == Some(t.as_str()))
            .ok_or_else(|| anyhow!("no window titled {t:?} in pid {pid}"))?,
        WindowSelector::WindowId(id) => {
            // Reconcile the CG window id to an AX window via bounds matching.
            match crate::windows_list::list_windows()
                .into_iter()
                .find(|w| w.window_id == id)
            {
                Some(target) => windows
                    .iter()
                    .position(|w| w.rect().map(|r| rect_close(&r, &target.bounds)).unwrap_or(false))
                    .unwrap_or(0),
                None => 0,
            }
        }
    };

    let chosen = windows
        .into_iter()
        .nth(idx)
        .ok_or_else(|| anyhow!("window index {idx} out of range for pid {pid}"))?;
    Ok(walk_node(&chosen, max_depth))
}

/// Loose rect equality (within 4pt) — AX vs CGWindowList bounds drift slightly.
fn rect_close(a: &ScreenRect, b: &ScreenRect) -> bool {
    (a.x - b.x).abs() < 4.0
        && (a.y - b.y).abs() < 4.0
        && (a.w - b.w).abs() < 4.0
        && (a.h - b.h).abs() < 4.0
}

/// Walk the app's main window, screenshot it, sample a deduped color palette
/// from the AX node centers. Reuses [`crate::sampling`] end-to-end.
pub fn window_palette(pid: i32, max_depth: u32) -> Result<Vec<(u8, u8, u8)>> {
    use base64::Engine as _;
    let mut node = walk_window(pid, WindowSelector::Main, max_depth)?;
    let root_bounds = node
        .bounds
        .ok_or_else(|| anyhow!("main window of pid {pid} has no bounds"))?;
    let shot = crate::screenshot::capture_region_b64(root_bounds)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&shot.png_b64)
        .map_err(|e| anyhow!("base64 decode: {e}"))?;
    let img = image::load_from_memory(&bytes)?.into_rgba8();
    crate::sampling::fill_node_colors(&mut node, &img, root_bounds);
    let mut palette = Vec::new();
    crate::sampling::collect_palette(&node, &mut palette);
    Ok(palette)
}

#[cfg(test)]
mod shallow_tests {
    use super::is_shallow_pick;
    use crate::capture::{ScreenPoint, ScreenRect};

    #[test]
    fn menu_bar_is_shallow_even_when_it_contains_the_click() {
        // The exact bug: a Slack sidebar click resolves to the menu bar strip.
        let menubar = ScreenRect { x: 0.0, y: 0.0, w: 1440.0, h: 30.0 };
        assert!(is_shallow_pick("AXMenuBar", &menubar, ScreenPoint { x: 700.0, y: 10.0 }, None, 5));
    }

    #[test]
    fn click_outside_bounds_is_shallow() {
        let menubar = ScreenRect { x: 0.0, y: 0.0, w: 1440.0, h: 30.0 };
        // sidebar click far below the menu bar — bounds don't contain it.
        assert!(is_shallow_pick("AXMenuBar", &menubar, ScreenPoint { x: 150.0, y: 400.0 }, None, 0));
    }

    #[test]
    fn real_button_containing_click_is_not_shallow() {
        let btn = ScreenRect { x: 100.0, y: 380.0, w: 220.0, h: 34.0 };
        let win = ScreenRect { x: 0.0, y: 25.0, w: 1440.0, h: 875.0 };
        assert!(!is_shallow_pick("AXButton", &btn, ScreenPoint { x: 150.0, y: 400.0 }, Some(&win), 0));
    }

    #[test]
    fn empty_window_sized_element_is_shallow() {
        // Electron: AX returns one window-filling container with ~no children.
        let win = ScreenRect { x: 0.0, y: 25.0, w: 1440.0, h: 875.0 };
        let huge = ScreenRect { x: 0.0, y: 25.0, w: 1440.0, h: 870.0 }; // ~entire window
        assert!(is_shallow_pick("AXGroup", &huge, ScreenPoint { x: 150.0, y: 400.0 }, Some(&win), 0));
    }

    #[test]
    fn rich_window_sized_native_group_is_not_shallow() {
        // The Calendar bug: "Year Calendar Area" fills the window but holds the 12
        // month grids — a legitimate pick. Must NOT be treated as shallow (which
        // would shrink it to a tiny click-centered box on commit).
        let win = ScreenRect { x: 0.0, y: 25.0, w: 935.0, h: 598.0 };
        let area = ScreenRect { x: 0.0, y: 25.0, w: 935.0, h: 595.0 }; // ~entire window
        assert!(!is_shallow_pick("AXGroup", &area, ScreenPoint { x: 400.0, y: 300.0 }, Some(&win), 12));
    }
}
