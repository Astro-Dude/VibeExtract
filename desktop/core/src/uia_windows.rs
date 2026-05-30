//! Windows UI Automation (UIA) picker — Phase 3 stubs.
//!
//! This module compiles on Windows but is intentionally a minimal skeleton.
//! The full UIA tree walk + element-from-point + window enumeration needs to
//! be exercised on an actual Windows machine; structure provided here so the
//! Tauri app's dispatcher can target it cross-platform.

use crate::capture::{PickedElement, ScreenPoint, ScreenRect};
use anyhow::Result;

#[cfg(target_os = "windows")]
pub fn current_cursor() -> ScreenPoint {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut pt = POINT { x: 0, y: 0 };
    unsafe {
        let _ = GetCursorPos(&mut pt);
    }
    ScreenPoint {
        x: pt.x as f64,
        y: pt.y as f64,
    }
}

#[cfg(target_os = "windows")]
pub fn pick(point: ScreenPoint) -> Result<PickedElement> {
    // TODO Phase 3: call IUIAutomation::ElementFromPoint, walk to enclosing window,
    // get the PID via GetWindowThreadProcessId, executable path via QueryFullProcessImageNameW.
    // For now, return a stub so the dispatcher can compile and call into us.
    anyhow::bail!("Windows UIA picker not yet implemented — see TODOs in uia_windows.rs (Phase 3)")
}

#[cfg(target_os = "windows")]
#[derive(Debug, Clone)]
pub struct UiaNode {
    pub control_type: String,
    pub name: String,
    pub automation_id: Option<String>,
    pub class_name: Option<String>,
    pub bounds: Option<ScreenRect>,
    pub children: Vec<UiaNode>,
}
