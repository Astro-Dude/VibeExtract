//! Tool parameter structs for the embedded MCP server.
//!
//! Each is `Deserialize + JsonSchema` so rmcp's `#[tool]` macro can both parse
//! the incoming `arguments` and advertise a JSON Schema in `tools/list`.
//! `schemars` is re-exported by rmcp (version-matched) — use that path so we
//! never fight a schemars version skew.

use rmcp::schemars;
use serde::Deserialize;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct RequestPermissionParam {
    /// When true, also open System Settings → Privacy → Accessibility.
    #[serde(default)]
    pub prompt: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ListWindowsParam {
    /// Optional: only return windows owned by this process id.
    #[serde(default)]
    pub pid: Option<i32>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct AxTreeParam {
    /// Process id of the target app (from `frontmost_app` or `list_windows`).
    pub pid: i32,
    /// Max recursion depth. Defaults to 12 — deep enough for most windows,
    /// shallow enough to bound huge Electron trees.
    #[serde(default)]
    pub max_depth: Option<u32>,
    /// Optional: walk a single window (index into the app's `AXWindows`)
    /// instead of the whole application root.
    #[serde(default)]
    pub window_index: Option<usize>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct PointParam {
    /// Screen x in points (top-left origin).
    pub x: f64,
    /// Screen y in points (top-left origin).
    pub y: f64,
    /// Optional: hit-test inside this specific process id.
    #[serde(default)]
    pub pid: Option<i32>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SubtreeParam {
    pub x: f64,
    pub y: f64,
    #[serde(default)]
    pub max_depth: Option<u32>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct RectParam {
    /// Region origin x in points (top-left origin).
    pub x: f64,
    pub y: f64,
    /// Region width/height in points.
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct WindowShotParam {
    pub pid: i32,
    /// Which window (index into `AXWindows`). Defaults to the first.
    #[serde(default)]
    pub window_index: Option<usize>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SampleColorParam {
    /// Screen point to sample, in points (top-left origin).
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct PaletteParam {
    pub pid: i32,
    #[serde(default)]
    pub max_depth: Option<u32>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct RelaunchParam {
    /// Bundle id of the Electron app (e.g. `com.tinyspeck.slackmacgap`).
    pub bundle_id: String,
    /// Human display name used for AppleScript quit + `open -a` (e.g. `Slack`).
    pub display_name: String,
    /// MUST be true to actually quit + relaunch the app. This is destructive
    /// (it closes the user's running app), so it never happens implicitly.
    #[serde(default)]
    pub confirm: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ExtractComponentParam {
    pub x: f64,
    pub y: f64,
    #[serde(default)]
    pub pid: Option<i32>,
    /// When true, skip the Electron relaunch prompt and fall straight through
    /// to the AX/screenshot path.
    #[serde(default)]
    pub skip_relaunch: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct CompareImagesParam {
    /// Native reference PNG by file path (e.g. the `path` returned by
    /// `screenshot_region`/`screenshot_window`). Preferred — base64 is awkward
    /// to pass between tools.
    #[serde(default)]
    pub a_path: Option<String>,
    /// …or the native reference as a base64 PNG.
    #[serde(default)]
    pub a_png_b64: Option<String>,
    /// Replica PNG by file path (e.g. the file the Playwright MCP wrote).
    #[serde(default)]
    pub b_path: Option<String>,
    /// …or the replica as a base64 PNG.
    #[serde(default)]
    pub b_png_b64: Option<String>,
    /// Optional pass threshold in 0..1 (default 0.92); only affects the
    /// reported `pass` flag — the score is always returned.
    #[serde(default)]
    pub threshold: Option<f64>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ExtractAssetsParam {
    /// CDP page-target index (into the debug port's `/json` page list).
    /// Defaults to 0 — the app's main window.
    #[serde(default)]
    pub target_index: Option<usize>,
    /// Subdirectory (under the MCP output dir) to write assets into.
    /// Defaults to `assets`. Files land in `<out>/<subdir>/{fonts,img}`.
    #[serde(default)]
    pub out_subdir: Option<String>,
}
