//! Cross-platform picker entry point. Internally dispatches to `ax_macos` /
//! `uia_windows`. Public re-export of [`crate::capture::PickedElement`].

pub use crate::capture::PickedElement;
use crate::capture::ScreenPoint;
use anyhow::Result;

/// Pick the element under the given screen point (or the live cursor if `None`).
pub fn pick_under_cursor(point: Option<ScreenPoint>) -> Result<PickedElement> {
    #[cfg(target_os = "macos")]
    {
        let point = point.unwrap_or_else(crate::ax_macos::current_cursor);
        return crate::ax_macos::pick(point);
    }
    #[cfg(target_os = "windows")]
    {
        let point = point.unwrap_or_else(crate::uia_windows::current_cursor);
        return crate::uia_windows::pick(point);
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = point;
        anyhow::bail!("unsupported platform — only macOS and Windows are supported")
    }
}
