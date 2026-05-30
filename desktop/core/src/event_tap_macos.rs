//! System-level mouse click capture via macOS CGEventTap.
//!
//! Why this exists: Tauri 2's `set_ignore_cursor_events(false)` is unreliable
//! on a transparent + always-on-top + non-focused webview window. Clicks pass
//! straight through our overlay even when we want to capture them. The robust
//! fix is to install a system-wide event tap that intercepts left mouse-down
//! events at the OS level — this is how every macOS screen-capture / picker
//! tool (CleanShot, Skitch, Rectangle) handles the same problem.
//!
//! Public API:
//! - [`install_mouse_down_tap(callback)`] — install a tap. Returns a handle.
//! - [`TapHandle::drop`] — automatically removes the tap when dropped.
//!
//! The callback runs on a dedicated thread (the one owning the tap's run loop)
//! whenever a left mouse-down occurs anywhere in the system. It receives the
//! cursor position (screen-global, points) and whether shift was held.
//!
//! Permissions: `kCGSessionEventTap` for mouse events requires Accessibility
//! permission only (which we already have). It does NOT need separate Input
//! Monitoring TCC.

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex;

use core_foundation::base::CFRelease;
use core_graphics::display::CGPoint;

// --- FFI -------------------------------------------------------------------

#[allow(non_camel_case_types)]
type CGEventRef = *const c_void;
#[allow(non_camel_case_types)]
type CGEventTapProxy = *const c_void;
#[allow(non_camel_case_types)]
type CGEventMask = u64;
#[allow(non_camel_case_types)]
type CGEventType = u32;
#[allow(non_camel_case_types)]
type CFMachPortRef = *const c_void;
#[allow(non_camel_case_types)]
type CFRunLoopRef = *const c_void;
#[allow(non_camel_case_types)]
type CFRunLoopSourceRef = *const c_void;
#[allow(non_camel_case_types)]
type CFStringRef = *const c_void;
#[allow(non_camel_case_types)]
type CFAllocatorRef = *const c_void;

const K_CG_SESSION_EVENT_TAP: u32 = 1;
const K_CG_HEAD_INSERT_EVENT_TAP: u32 = 0;
const K_CG_EVENT_TAP_OPTION_DEFAULT: u32 = 0;

// CGEventType values
const K_CG_EVENT_LEFT_MOUSE_DOWN: u32 = 1;

// CGEventFlags bit for shift
const K_CG_EVENT_FLAG_MASK_SHIFT: u64 = 0x00020000;

type CGEventTapCallBack = unsafe extern "C" fn(
    proxy: CGEventTapProxy,
    event_type: CGEventType,
    event: CGEventRef,
    user_info: *mut c_void,
) -> CGEventRef;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventTapCreate(
        tap: u32,
        place: u32,
        options: u32,
        events_of_interest: CGEventMask,
        callback: CGEventTapCallBack,
        user_info: *mut c_void,
    ) -> CFMachPortRef;
    fn CGEventTapEnable(tap: CFMachPortRef, enable: bool);
    fn CGEventGetLocation(event: CGEventRef) -> CGPoint;
    fn CGEventGetFlags(event: CGEventRef) -> u64;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFMachPortCreateRunLoopSource(
        allocator: CFAllocatorRef,
        port: CFMachPortRef,
        order: i32,
    ) -> CFRunLoopSourceRef;
    fn CFRunLoopGetCurrent() -> CFRunLoopRef;
    fn CFRunLoopAddSource(rl: CFRunLoopRef, source: CFRunLoopSourceRef, mode: CFStringRef);
    fn CFRunLoopRun();
    fn CFRunLoopStop(rl: CFRunLoopRef);

    static kCFRunLoopCommonModes: CFStringRef;
}

// --- Global callback storage ----------------------------------------------
//
// The C callback ABI has no slot for closure capture, so we stash the user's
// callback in a global. The tap is mutually exclusive (only one pick session
// at a time), so a single slot is fine.

type ClickCallback = Box<dyn Fn(f64, f64, bool) + Send + Sync>;

static GLOBAL_CALLBACK: Mutex<Option<ClickCallback>> = Mutex::new(None);

unsafe extern "C" fn tap_callback(
    _proxy: CGEventTapProxy,
    event_type: CGEventType,
    event: CGEventRef,
    _user_info: *mut c_void,
) -> CGEventRef {
    // Only handle left mouse-down. Other event types pass through unchanged.
    if event_type != K_CG_EVENT_LEFT_MOUSE_DOWN {
        return event;
    }

    let pt = CGEventGetLocation(event);
    let flags = CGEventGetFlags(event);
    let shift = (flags & K_CG_EVENT_FLAG_MASK_SHIFT) != 0;

    let consumed = {
        let guard = GLOBAL_CALLBACK.lock().unwrap();
        if let Some(cb) = guard.as_ref() {
            cb(pt.x, pt.y, shift);
            true
        } else {
            false
        }
    };

    if consumed {
        // Consume the event so the underlying app doesn't see the click —
        // matches the web extension's `preventDefault + stopPropagation`.
        std::ptr::null()
    } else {
        // No active session: pass through normally.
        event
    }
}

// --- Public handle ---------------------------------------------------------

pub struct TapHandle {
    /// The dedicated thread running the tap's CFRunLoop. We stop it on drop.
    thread: Option<std::thread::JoinHandle<()>>,
    /// The thread's CFRunLoop, used to wake it up so it can exit.
    runloop: Arc<Mutex<Option<usize>>>, // wraps CFRunLoopRef as usize for Send
    /// Tells the thread's run loop to stop once it's woken.
    shutdown: Arc<AtomicBool>,
}

impl Drop for TapHandle {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        // Stop the thread's run loop so it can exit.
        let runloop_ptr = self.runloop.lock().unwrap();
        if let Some(rl) = *runloop_ptr {
            unsafe { CFRunLoopStop(rl as CFRunLoopRef) };
        }
        drop(runloop_ptr);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
        // Clear the global callback last so any in-flight tap invocations
        // see the cleared state.
        *GLOBAL_CALLBACK.lock().unwrap() = None;
        log::info!("event_tap: removed");
    }
}

/// Install a system-wide left-mouse-down tap. The callback fires for every
/// click anywhere in the system. While the tap is installed, clicks are
/// consumed (do NOT reach the underlying app). Drop the handle to remove it.
pub fn install_mouse_down_tap<F>(callback: F) -> Result<TapHandle, String>
where
    F: Fn(f64, f64, bool) + Send + Sync + 'static,
{
    // Store the callback globally so the C callback can reach it.
    *GLOBAL_CALLBACK.lock().unwrap() = Some(Box::new(callback));

    let runloop_slot: Arc<Mutex<Option<usize>>> = Arc::new(Mutex::new(None));
    let runloop_slot_thread = runloop_slot.clone();
    let shutdown = Arc::new(AtomicBool::new(false));

    // Use a channel to receive a status signal from the thread (tap created OK,
    // or failed). Without this we'd return success even if tap creation failed.
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();

    let thread = std::thread::spawn(move || unsafe {
        let mask: CGEventMask = 1u64 << K_CG_EVENT_LEFT_MOUSE_DOWN;
        let tap = CGEventTapCreate(
            K_CG_SESSION_EVENT_TAP,
            K_CG_HEAD_INSERT_EVENT_TAP,
            K_CG_EVENT_TAP_OPTION_DEFAULT,
            mask,
            tap_callback,
            std::ptr::null_mut(),
        );
        if tap.is_null() {
            let _ = tx.send(Err(
                "CGEventTapCreate returned null — Accessibility permission may be missing or revoked.".into()
            ));
            return;
        }

        let source = CFMachPortCreateRunLoopSource(std::ptr::null(), tap, 0);
        if source.is_null() {
            let _ = tx.send(Err("CFMachPortCreateRunLoopSource returned null".into()));
            CFRelease(tap as *const _);
            return;
        }

        let runloop = CFRunLoopGetCurrent();
        CFRunLoopAddSource(runloop, source, kCFRunLoopCommonModes);
        CGEventTapEnable(tap, true);

        // Publish our run loop ref so the parent thread can stop us.
        *runloop_slot_thread.lock().unwrap() = Some(runloop as usize);
        let _ = tx.send(Ok(()));

        log::info!("event_tap: installed (running CFRunLoopRun on dedicated thread)");
        // Blocks until CFRunLoopStop is called from the parent thread's Drop.
        CFRunLoopRun();

        // Cleanup
        CGEventTapEnable(tap, false);
        CFRelease(source);
        CFRelease(tap as *const _);
        log::info!("event_tap: thread exited cleanly");
    });

    // Wait for the thread to report tap creation status.
    match rx.recv() {
        Ok(Ok(())) => Ok(TapHandle {
            thread: Some(thread),
            runloop: runloop_slot,
            shutdown,
        }),
        Ok(Err(e)) => {
            // Clear global callback on failure.
            *GLOBAL_CALLBACK.lock().unwrap() = None;
            Err(e)
        }
        Err(e) => {
            *GLOBAL_CALLBACK.lock().unwrap() = None;
            Err(format!("tap thread died before reporting status: {}", e))
        }
    }
}
