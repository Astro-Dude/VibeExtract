//! Primitive types passed between modules.

use serde::{Deserialize, Serialize};

/// A point in screen coordinates (AX coord space: top-left origin, points).
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct ScreenPoint {
    pub x: f64,
    pub y: f64,
}

/// A rectangle in screen coordinates.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct ScreenRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl ScreenRect {
    pub fn is_valid(&self) -> bool {
        self.w >= 1.0 && self.h >= 1.0
    }
    pub fn center(&self) -> ScreenPoint {
        ScreenPoint {
            x: self.x + self.w / 2.0,
            y: self.y + self.h / 2.0,
        }
    }
}

/// Information about the element the picker identified, used by the
/// dispatcher to decide which strategy to apply.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PickedElement {
    /// Accessibility role (AXButton, AXGroup, AXWindow, etc. on macOS;
    /// ControlType.Button etc. on Windows).
    pub role: String,
    /// Sub-role / control sub-type when present.
    pub subrole: Option<String>,
    /// Best-effort name (AXTitle, AXDescription, AXLabel, AXValue chain).
    pub name: String,
    /// Accessibility identifier (when set by the app — these are gold for
    /// matching against decompiled XAML / NIB resources).
    pub identifier: Option<String>,
    /// Element bounds in screen coordinates.
    pub bounds: ScreenRect,
    /// PID of the process that owns the element.
    pub pid: i32,
    /// Bundle ID / executable path of the owning app. Used by the dispatcher
    /// to locate Info.plist, app.asar, etc.
    pub app_path: Option<String>,
    /// Best-effort title of the enclosing window (for the warning banner when
    /// the wrong window is on top).
    pub window_title: Option<String>,
    /// Enclosing window bounds — used for coord translation when running the
    /// CDP path.
    pub window_bounds: Option<ScreenRect>,
}
