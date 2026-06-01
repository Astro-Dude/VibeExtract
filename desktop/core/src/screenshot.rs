//! Per-element screenshot. macOS uses the built-in `/usr/sbin/screencapture -R`;
//! Windows uses a `BitBlt` from the desktop DC (Phase 3 stub for now).

use crate::capture::ScreenRect;
use anyhow::{bail, Context, Result};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(target_os = "macos")]
pub fn capture_region(bounds: ScreenRect, out_path: &Path) -> Result<()> {
    if !bounds.is_valid() {
        bail!("zero-sized bounds: {:?}", bounds);
    }
    let region = format!("{:.0},{:.0},{:.0},{:.0}", bounds.x, bounds.y, bounds.w, bounds.h);
    let status = std::process::Command::new("/usr/sbin/screencapture")
        .args(["-x", "-R", &region])
        .arg(out_path)
        .status()
        .context("invoking /usr/sbin/screencapture")?;
    if !status.success() {
        bail!("screencapture exited with status {:?}", status.code());
    }
    if !out_path.exists() {
        bail!("screencapture didn't produce {}", out_path.display());
    }
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn capture_region(bounds: ScreenRect, out_path: &Path) -> Result<()> {
    // Phase 3 TODO: BitBlt from the desktop DC.
    // For now, write an empty PNG so the rest of the pipeline doesn't break.
    let _ = bounds;
    std::fs::write(out_path, &EMPTY_PNG)?;
    Ok(())
}

#[cfg(target_os = "windows")]
const EMPTY_PNG: [u8; 67] = [
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
    0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
    0x42, 0x60, 0x82,
];

// --- Base64 capture for the MCP layer ----------------------------------------
//
// `capture_region` writes a PNG to disk; the MCP server instead wants the image
// inline (returned to Claude as an image content block) plus the device-pixel
// dimensions so the Retina point↔pixel scale is explicit (see `image_diff`).
// Cross-platform: routes through `capture_region`, so the Windows stub just
// yields a 1×1 empty PNG with scale 1.

static SHOT_SEQ: AtomicU64 = AtomicU64::new(0);

/// A screenshot returned inline. `scale = px_w / point_w` (≈2.0 on Retina).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShotResult {
    /// Standard base64 of the PNG bytes.
    pub png_b64: String,
    /// True device-pixel dimensions of the PNG.
    pub px_w: u32,
    pub px_h: u32,
    /// The point-space size that was requested (matches the input `ScreenRect`).
    pub point_w: f64,
    pub point_h: f64,
    /// Device-pixels per point — render the replica at point size, then let the
    /// verifier's resize absorb this factor.
    pub scale: f64,
}

/// Capture a screen region (points) and return it inline as base64 + dimensions.
pub fn capture_region_b64(bounds: ScreenRect) -> Result<ShotResult> {
    let seq = SHOT_SEQ.fetch_add(1, Ordering::Relaxed);
    let path = std::env::temp_dir().join(format!(
        "vibe-extract-shot-{}-{}.png",
        std::process::id(),
        seq
    ));
    capture_region(bounds, &path)?;
    let bytes =
        std::fs::read(&path).with_context(|| format!("reading screenshot {}", path.display()))?;
    let (px_w, px_h) = image::image_dimensions(&path).unwrap_or((0, 0));
    let _ = std::fs::remove_file(&path); // best-effort cleanup
    let png_b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let scale = if bounds.w > 0.0 && px_w > 0 {
        px_w as f64 / bounds.w
    } else {
        1.0
    };
    Ok(ShotResult {
        png_b64,
        px_w,
        px_h,
        point_w: bounds.w,
        point_h: bounds.h,
        scale,
    })
}

/// Capture a window enumerated by [`crate::windows_list::list_windows`].
pub fn capture_window_b64(win: &crate::windows_list::WindowInfo) -> Result<ShotResult> {
    capture_region_b64(win.bounds)
}

/// Sample the on-screen color at a single point (top-left origin, points).
/// Captures a tiny region around the point and returns its top-left pixel.
pub fn sample_point(at: ScreenPoint) -> Result<(u8, u8, u8)> {
    let bounds = ScreenRect {
        x: at.x,
        y: at.y,
        w: 2.0,
        h: 2.0,
    };
    let seq = SHOT_SEQ.fetch_add(1, Ordering::Relaxed);
    let path = std::env::temp_dir().join(format!(
        "vibe-extract-px-{}-{}.png",
        std::process::id(),
        seq
    ));
    capture_region(bounds, &path)?;
    let img = image::open(&path)
        .with_context(|| format!("decoding {}", path.display()))?
        .into_rgba8();
    let _ = std::fs::remove_file(&path);
    if img.width() == 0 || img.height() == 0 {
        bail!("empty capture at ({}, {})", at.x, at.y);
    }
    let p = img.get_pixel(0, 0);
    Ok((p[0], p[1], p[2]))
}
