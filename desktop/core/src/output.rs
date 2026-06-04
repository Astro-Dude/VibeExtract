//! What the dispatcher returns. Same shape across all strategies so the
//! frontend doesn't care whether the source was CDP, AX, NIB, or asar.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaptureResult {
    /// Which strategy ultimately produced the output.
    pub strategy: String,
    /// Human-readable fidelity badge ("Source-perfect", "Pixel-perfect runtime",
    /// "Sampled colors + screenshot", etc.) — shown in the picker UI so the
    /// user knows what they're getting.
    pub fidelity: String,
    /// TOON output (text). May be empty for screenshot-only strategy.
    pub toon: String,
    /// HTML output (self-contained — fonts inlined or linked; for native paths
    /// the source screenshot is embedded as base64).
    pub html: String,
    /// Optional base64-encoded PNG screenshot of the picked element bounds.
    /// Always present for native paths; absent (None) for source-perfect paths.
    pub screenshot_png_b64: Option<String>,
    /// Free-form per-strategy diagnostics (passed to the export view's
    /// diagnostics panel).
    pub diagnostics: Vec<String>,
}

impl CaptureResult {
    pub fn empty(strategy: impl Into<String>, fidelity: impl Into<String>) -> Self {
        Self {
            strategy: strategy.into(),
            fidelity: fidelity.into(),
            toon: String::new(),
            html: String::new(),
            screenshot_png_b64: None,
            diagnostics: Vec::new(),
        }
    }
}
