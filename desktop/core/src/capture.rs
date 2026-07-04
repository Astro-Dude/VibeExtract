//! Primitive types passed between modules.

use serde::{Deserialize, Serialize};

/// The pick-time AX subtree type carried by [`PickedElement::ax_tree`]. On macOS it is
/// the real typed [`crate::ax_macos::Node`] (held in RAM, serialized inline into
/// `last-selection.json`); off-macOS — where the picker never produces one — it degrades
/// to opaque JSON so the cross-platform struct still compiles.
#[cfg(target_os = "macos")]
pub type AxTree = crate::ax_macos::Node;
#[cfg(not(target_os = "macos"))]
pub type AxTree = serde_json::Value;

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
    /// Does this rect contain the point (inclusive)? Used to sanity-check that an
    /// AX hit-test actually landed on the element under the click.
    pub fn contains(&self, p: ScreenPoint) -> bool {
        p.x >= self.x && p.x <= self.x + self.w && p.y >= self.y && p.y <= self.y + self.h
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
    /// The exact screen point the user clicked/hovered when this element was
    /// picked (the pick anchor, points / top-left origin). Always reliable even
    /// when AX can't resolve a real leaf, so downstream can re-resolve precisely
    /// here via the CDP ladder. `#[serde(default)]` keeps older records loadable.
    #[serde(default)]
    pub click: Option<ScreenPoint>,
    /// True when the AX hit-test could NOT land on a real content element at the
    /// click — e.g. an Electron app whose web content isn't exposed to macOS AX,
    /// so only a top-level container / menu bar came back. When set, do NOT trust
    /// `bounds`/`role`; re-resolve at `click` (extract_component / the CDP ladder).
    #[serde(default)]
    pub ax_shallow: bool,
    /// Absolute path to a PNG of this element captured AT PICK-TIME (when the
    /// target app is frontmost by definition), cropped from a `screencapture -l`
    /// of the owning window so it's free of the pick overlay's highlight border.
    /// Lets downstream (`get_selection` → `/replicate-ui`) use the real pixels as
    /// the native reference even after the app is closed/backgrounded. `None` when
    /// the pick-time capture failed (best-effort) or for older records.
    #[serde(default)]
    pub crop_path: Option<String>,
    /// Full AX subtree rooted at the picked element, captured AT PICK-TIME while the
    /// target app was running (before any freeze). Lets `get_selection` → `/replicate-ui`
    /// use the element's structure even after the app is closed/backgrounded, instead of
    /// a live `ax_subtree_at_point` that needs the app present. `None` for shallow
    /// (Electron) picks — use the CDP/`extract_component` path — for trees over the node
    /// cap, when the pick-time walk failed (best-effort), or for older records.
    #[serde(default)]
    pub ax_tree: Option<AxTree>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rect_contains_point_inclusive() {
        let r = ScreenRect { x: 10.0, y: 20.0, w: 100.0, h: 40.0 };
        assert!(r.contains(ScreenPoint { x: 50.0, y: 30.0 })); // inside
        assert!(r.contains(ScreenPoint { x: 10.0, y: 20.0 })); // top-left corner
        assert!(r.contains(ScreenPoint { x: 110.0, y: 60.0 })); // bottom-right corner
        assert!(!r.contains(ScreenPoint { x: 5.0, y: 30.0 })); // left of
        assert!(!r.contains(ScreenPoint { x: 50.0, y: 61.0 })); // below
    }
}
