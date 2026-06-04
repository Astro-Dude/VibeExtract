// Phase 1a spike: cursor-following AX hit-test on macOS.
//
// Polls the mouse cursor at 10Hz, calls AXUIElementCopyElementAtPosition on the
// system-wide AX element, and prints one line per tick describing the element
// under the cursor (role, title/description/value, bounds, identifier).
//
// This is the smallest meaningful slice of Desktop_Pluck's PickerService —
// later phases will add: overlay window, refinement keys, global hotkey,
// 30Hz polling, and the full attribute dump (actions, state, navigation order).
//
// Run with:
//   cargo run --release
// First run will print "AX permission required" — grant it in
// System Settings → Privacy & Security → Accessibility, then re-run.

use anyhow::{bail, Context, Result};
use core_foundation::base::{CFGetTypeID, CFRelease, CFTypeRef, TCFType, ToVoid};
use core_foundation::boolean::{kCFBooleanTrue, CFBoolean};
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::{CFString, CFStringRef};
use core_graphics::display::CGPoint;
use std::ffi::c_void;
use std::time::Duration;

// --- FFI: ApplicationServices (Accessibility) ---------------------------------
//
// macOS doesn't ship Rust bindings for the AX C API, so declare the few
// functions we need by hand. They live in ApplicationServices.framework,
// which the linker pulls in via the cargo `links` instruction below.

#[allow(non_camel_case_types)]
type AXUIElementRef = *const c_void;
#[allow(non_camel_case_types)]
type AXValueRef = *const c_void;
#[allow(non_camel_case_types)]
type AXError = i32;

const K_AX_ERROR_SUCCESS: AXError = 0;

// AXValueType constants (from AXValue.h)
const K_AX_VALUE_TYPE_CG_POINT: u32 = 1;
const K_AX_VALUE_TYPE_CG_SIZE: u32 = 2;
// const K_AX_VALUE_TYPE_CG_RECT: u32 = 3; // unused for now
// const K_AX_VALUE_TYPE_CF_RANGE: u32 = 4;

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

// CGEventSource for getting cursor location.
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventCreate(source: *const c_void) -> *const c_void;
    fn CGEventGetLocation(event: *const c_void) -> CGPoint;
}

// `kAXTrustedCheckOptionPrompt` is a CFStringRef constant exported by HIServices.
// We can't import it directly as a static via #[link] in stable Rust, so we
// re-create the key by name via CFString::from_static_string — the docs guarantee
// the literal "AXTrustedCheckOptionPrompt".

// ------------------------------------------------------------------------------

struct AxElement(AXUIElementRef);

impl Drop for AxElement {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CFRelease(self.0 as *const _) };
        }
    }
}

impl AxElement {
    /// Read a string attribute (returns None if absent or wrong type).
    fn str_attr(&self, key: &str) -> Option<String> {
        let key_cf = CFString::new(key);
        let mut value: CFTypeRef = std::ptr::null();
        let err = unsafe {
            AXUIElementCopyAttributeValue(self.0, key_cf.as_concrete_TypeRef(), &mut value)
        };
        if err != K_AX_ERROR_SUCCESS || value.is_null() {
            return None;
        }
        // Only treat as string if it's a CFString.
        let type_id = unsafe { CFGetTypeID(value) };
        if type_id == CFString::type_id() {
            let s = unsafe { CFString::wrap_under_create_rule(value as CFStringRef) };
            Some(s.to_string())
        } else {
            unsafe { CFRelease(value) };
            None
        }
    }

    /// Read a CGPoint attribute (e.g. AXPosition).
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
        if ok {
            Some(pt)
        } else {
            None
        }
    }

    /// Read a CGSize attribute (e.g. AXSize). Returned as (width, height).
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
        if ok {
            Some((sz.width, sz.height))
        } else {
            None
        }
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

fn check_or_request_permission() -> bool {
    // Fast path — already trusted.
    if unsafe { AXIsProcessTrusted() } {
        return true;
    }
    // Build {kAXTrustedCheckOptionPrompt: true} dict and call the prompting form
    // so macOS surfaces the system permission dialog the first time.
    let key = CFString::from_static_string("AXTrustedCheckOptionPrompt");
    let value = unsafe { CFBoolean::wrap_under_get_rule(kCFBooleanTrue) };
    let dict: CFDictionary<CFString, CFBoolean> =
        CFDictionary::from_CFType_pairs(&[(key, value)]);
    unsafe { AXIsProcessTrustedWithOptions(dict.to_void()) }
}

fn main() -> Result<()> {
    eprintln!("[picker] checking AX permission...");
    if !check_or_request_permission() {
        // Best-effort: pop the System Settings pane directly so the user can grant.
        let _ = std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
            .status();
        bail!(
            "AX permission denied. System Settings → Privacy & Security → Accessibility just opened.\n\
             Add (or check) this binary:  {}\n\n\
             Note: ad-hoc-signed dev builds re-prompt on every rebuild. Phase 1d will add a\n\
             stable codesigning script (mirroring Desktop_Pluck's setup-codesign.sh) so the\n\
             TCC grant survives rebuilds.",
            std::env::current_exe().context("current_exe")?.display()
        );
    }
    eprintln!("[picker] AX permission OK. Move the mouse around for 15s — each tick prints the element under the cursor. Ctrl-C to exit.");

    let system: AXUIElementRef = unsafe { AXUIElementCreateSystemWide() };
    if system.is_null() {
        bail!("AXUIElementCreateSystemWide returned null");
    }

    let tick = Duration::from_millis(100); // 10Hz
    let mut last_signature = String::new();

    for _ in 0..150 {
        let pt = current_cursor();
        let line = match element_under_cursor(system, pt) {
            Some(el) => {
                let role = el.str_attr("AXRole").unwrap_or_else(|| "?".into());
                let subrole = el.str_attr("AXSubrole");
                let name = el
                    .str_attr("AXTitle")
                    .or_else(|| el.str_attr("AXDescription"))
                    .or_else(|| el.str_attr("AXLabel"))
                    .or_else(|| el.str_attr("AXValue"))
                    .unwrap_or_else(|| "(anon)".into());
                let ident = el.str_attr("AXIdentifier").unwrap_or_default();
                let pos = el.point_attr("AXPosition");
                let size = el.size_attr("AXSize");

                let role_str = match subrole {
                    Some(sub) => format!("{}:{}", role, sub),
                    None => role,
                };
                let bounds = match (pos, size) {
                    (Some(p), Some((w, h))) => format!("pos=({:.0},{:.0}) size=({:.0}x{:.0})", p.x, p.y, w, h),
                    _ => String::from("pos=? size=?"),
                };
                let ident_str = if ident.is_empty() { String::new() } else { format!("  #{}", ident) };
                let name_trunc: String = name.chars().take(60).collect();
                format!(
                    "cursor=({:.0},{:.0})  {}  \"{}\"  {}{}",
                    pt.x, pt.y, role_str, name_trunc, bounds, ident_str
                )
            }
            None => format!("cursor=({:.0},{:.0})  (no AX element)", pt.x, pt.y),
        };

        // Avoid spamming when nothing changes between ticks.
        if line != last_signature {
            println!("{}", line);
            last_signature = line;
        }

        std::thread::sleep(tick);
    }

    eprintln!("[picker] done.");
    Ok(())
}
