//! On-screen window enumeration via `CGWindowListCopyWindowInfo`.
//!
//! Returns one [`WindowInfo`] per visible window — pid, owning-app name, window
//! title, bounds (in points, top-left origin — the same space AX and
//! `screenshot::capture_region` use), the stable CG window id, and the window
//! layer. The MCP `list_windows` tool wraps this so Claude can pick a target
//! window before walking its AX tree or screenshotting it.
//!
//! This is a deliberately self-contained copy of the CGWindowList FFI + the
//! CF-dictionary readers (rather than reaching into `ax_macos`) so the new MCP
//! surface doesn't couple to the volatile picker code path.

use crate::capture::ScreenRect;
use serde::{Deserialize, Serialize};

/// One on-screen window.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowInfo {
    /// Owning process id.
    pub pid: i32,
    /// Owning application name (`kCGWindowOwnerName`).
    pub app_name: Option<String>,
    /// Window title (`kCGWindowName`). Often `None`/empty unless the app has
    /// granted the Screen Recording privilege to the caller.
    pub title: Option<String>,
    /// Bounds in points (top-left origin) — feedable straight to
    /// `screenshot::capture_region`.
    pub bounds: ScreenRect,
    /// Stable Core Graphics window id (`kCGWindowNumber`).
    pub window_id: u32,
    /// Window layer (`kCGWindowLayer`). 0 is the normal app layer; menus, the
    /// Dock, and overlays use higher layers.
    pub layer: i32,
}

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use core_foundation::array::CFArray;
    use core_foundation::base::{CFGetTypeID, TCFType};
    use core_foundation::dictionary::CFDictionaryRef;
    use core_foundation::number::CFNumberRef;
    use core_foundation::string::{CFString, CFStringRef};
    use std::ffi::c_void;

    const K_CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY: u32 = 1 << 0;
    const K_CG_NULL_WINDOW_ID: u32 = 0;
    // CFNumberType: kCFNumberSInt32Type=3, kCFNumberDoubleType=13.
    const K_CF_NUMBER_SINT32: i32 = 3;
    const K_CF_NUMBER_DOUBLE: i32 = 13;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGWindowListCopyWindowInfo(option: u32, relative_to_window: u32) -> *const c_void;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFDictionaryGetValue(the_dict: CFDictionaryRef, key: *const c_void) -> *const c_void;
        fn CFNumberGetValue(number: CFNumberRef, the_type: i32, value_ptr: *mut c_void) -> bool;
    }

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
        let ok = unsafe {
            CFNumberGetValue(
                v as CFNumberRef,
                K_CF_NUMBER_SINT32,
                &mut out as *mut i32 as *mut c_void,
            )
        };
        if ok {
            Some(out)
        } else {
            None
        }
    }

    fn read_f64(dict: CFDictionaryRef, key: &str) -> Option<f64> {
        let v = cf_dict_get(dict, key);
        if v.is_null() {
            return None;
        }
        let mut out: f64 = 0.0;
        let ok = unsafe {
            CFNumberGetValue(
                v as CFNumberRef,
                K_CF_NUMBER_DOUBLE,
                &mut out as *mut f64 as *mut c_void,
            )
        };
        if ok {
            Some(out)
        } else {
            None
        }
    }

    /// Read a CFString dictionary value into a Rust `String`. Uses the
    /// `core_foundation` wrapper (proper UTF-8 conversion), not the brittle
    /// `CFStringGetCStringPtr` which frequently returns null.
    fn read_cfstring(dict: CFDictionaryRef, key: &str) -> Option<String> {
        let v = cf_dict_get(dict, key);
        if v.is_null() {
            return None;
        }
        if unsafe { CFGetTypeID(v) } != CFString::type_id() {
            return None;
        }
        // Get-rule value: wrap_under_get_rule retains it; Drop releases. Net zero.
        let s = unsafe { CFString::wrap_under_get_rule(v as CFStringRef) };
        let out = s.to_string();
        if out.is_empty() {
            None
        } else {
            Some(out)
        }
    }

    pub fn list_windows() -> Vec<WindowInfo> {
        let info_ref: *const c_void = unsafe {
            CGWindowListCopyWindowInfo(
                K_CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY,
                K_CG_NULL_WINDOW_ID,
            )
        };
        if info_ref.is_null() {
            return Vec::new();
        }
        let array: CFArray<*const c_void> =
            unsafe { CFArray::wrap_under_create_rule(info_ref as _) };

        let mut out = Vec::with_capacity(array.len() as usize);
        for i in 0..array.len() {
            let item = array.get(i).map(|r| *r).unwrap_or(std::ptr::null());
            if item.is_null() {
                continue;
            }
            let dict = item as CFDictionaryRef;
            let Some(pid) = read_i32(dict, "kCGWindowOwnerPID") else {
                continue;
            };
            if pid <= 0 {
                continue;
            }
            let bounds_ref = cf_dict_get(dict, "kCGWindowBounds");
            if bounds_ref.is_null() {
                continue;
            }
            let b = bounds_ref as CFDictionaryRef;
            let bounds = ScreenRect {
                x: read_f64(b, "X").unwrap_or(0.0),
                y: read_f64(b, "Y").unwrap_or(0.0),
                w: read_f64(b, "Width").unwrap_or(0.0),
                h: read_f64(b, "Height").unwrap_or(0.0),
            };
            // Drop degenerate windows (1×1 status-item helpers, etc.).
            if bounds.w <= 1.0 || bounds.h <= 1.0 {
                continue;
            }
            out.push(WindowInfo {
                pid,
                app_name: read_cfstring(dict, "kCGWindowOwnerName"),
                title: read_cfstring(dict, "kCGWindowName"),
                bounds,
                window_id: read_i32(dict, "kCGWindowNumber").unwrap_or(0) as u32,
                layer: read_i32(dict, "kCGWindowLayer").unwrap_or(0),
            });
        }
        out
    }
}

/// Enumerate every on-screen window (all apps). Bounds are in points.
#[cfg(target_os = "macos")]
pub fn list_windows() -> Vec<WindowInfo> {
    imp::list_windows()
}

/// Windows/other-platform stub — keeps the MCP tool surface compiling and
/// stable cross-platform. Real enumeration lands with the Windows port.
#[cfg(not(target_os = "macos"))]
pub fn list_windows() -> Vec<WindowInfo> {
    Vec::new()
}
