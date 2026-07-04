//! Per-element screenshot. macOS uses the built-in `/usr/sbin/screencapture -R`;
//! Windows uses a `BitBlt` from the desktop DC (Phase 3 stub for now).

use crate::capture::{ScreenPoint, ScreenRect};
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

// --- Overlapped capture (latency) --------------------------------------------
//
// The extraction hot path wants the screencapture child RUNNING while the AX
// tree walk happens on the calling thread (the AXUIElement is non-Send, the
// child is a separate OS process — free concurrency). `spawn_capture_region`
// starts the child; `PendingCapture::wait` joins it before the pixels are read.

/// A screencapture child in flight. Reaps the child on drop so an early error
/// return in the caller can't leak a zombie process.
pub struct PendingCapture {
    child: Option<std::process::Child>,
    out_path: std::path::PathBuf,
}

/// Start `/usr/sbin/screencapture` for `bounds` WITHOUT waiting for it.
#[cfg(target_os = "macos")]
pub fn spawn_capture_region(bounds: ScreenRect, out_path: &Path) -> Result<PendingCapture> {
    if !bounds.is_valid() {
        bail!("zero-sized bounds: {:?}", bounds);
    }
    let region = format!("{:.0},{:.0},{:.0},{:.0}", bounds.x, bounds.y, bounds.w, bounds.h);
    let child = std::process::Command::new("/usr/sbin/screencapture")
        .args(["-x", "-R", &region])
        .arg(out_path)
        .spawn()
        .context("spawning /usr/sbin/screencapture")?;
    Ok(PendingCapture {
        child: Some(child),
        out_path: out_path.to_path_buf(),
    })
}

/// Non-macOS fallback: capture synchronously up front; `wait()` is a no-op.
#[cfg(not(target_os = "macos"))]
pub fn spawn_capture_region(bounds: ScreenRect, out_path: &Path) -> Result<PendingCapture> {
    capture_region(bounds, out_path)?;
    Ok(PendingCapture {
        child: None,
        out_path: out_path.to_path_buf(),
    })
}

impl PendingCapture {
    /// Join the in-flight capture; errors mirror the blocking `capture_region`.
    pub fn wait(mut self) -> Result<()> {
        if let Some(mut child) = self.child.take() {
            let status = child.wait().context("waiting on screencapture")?;
            if !status.success() {
                bail!("screencapture exited with status {:?}", status.code());
            }
        }
        if !self.out_path.exists() {
            bail!("screencapture didn't produce {}", self.out_path.display());
        }
        Ok(())
    }
}

impl Drop for PendingCapture {
    fn drop(&mut self) {
        // Early-error path in the caller: reap so we never leave a zombie.
        // screencapture self-terminates in well under a second.
        if let Some(mut c) = self.child.take() {
            let _ = c.wait();
        }
    }
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

/// Capture ONLY the target window (by its CG `window_id`) and crop to `elem`,
/// saving the cropped PNG to `out_path`.
///
/// Uses `screencapture -l <id>`, which reads that window's backing store and
/// ignores anything composited above it — so the result is immune both to
/// occlusion (other windows on top, different Space) AND to our own pick-mode
/// highlight overlay. That's why this is preferred over `-R` region capture at
/// pick-time: a region grab would bake in the overlay's selection border.
///
/// `win` is the target window's bounds (points, top-left); `elem` is the element
/// rect in the same screen/point space. The device→point `scale` is derived from
/// the captured window pixels vs `win.w`, then used to map `elem` into the crop.
#[cfg(target_os = "macos")]
pub fn capture_window_crop(
    window_id: u32,
    win: ScreenRect,
    elem: ScreenRect,
    out_path: &Path,
) -> Result<()> {
    if !elem.is_valid() {
        bail!("zero-sized element bounds: {:?}", elem);
    }
    if win.w <= 0.0 || win.h <= 0.0 {
        bail!("invalid window bounds: {:?}", win);
    }
    let seq = SHOT_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = std::env::temp_dir().join(format!(
        "vibe-extract-winshot-{}-{}.png",
        std::process::id(),
        seq
    ));
    // `-x` silent, `-o` omit the window's drop shadow (so the PNG is exactly the
    // window content at win.w×win.h points × scale), `-l <id>` that window only.
    let status = std::process::Command::new("/usr/sbin/screencapture")
        .args(["-x", "-o", "-l", &window_id.to_string()])
        .arg(&tmp)
        .status()
        .context("invoking /usr/sbin/screencapture -l")?;
    if !status.success() {
        bail!("screencapture -l exited with status {:?}", status.code());
    }
    if !tmp.exists() {
        bail!("screencapture -l didn't produce {}", tmp.display());
    }
    let img = image::open(&tmp).with_context(|| format!("decoding window shot {}", tmp.display()))?;
    let _ = std::fs::remove_file(&tmp); // best-effort cleanup
    let (img_w, img_h) = (img.width(), img.height());
    if img_w == 0 || img_h == 0 {
        bail!("empty window capture for window_id={window_id}");
    }
    // Reject an element that doesn't meaningfully overlap the captured window.
    // A mis-resolved owning window (wrong layer / fallback) or a stale bound would
    // otherwise clamp into a 1px strip and be saved as if it were a valid crop —
    // a silently-wrong reference is worse than None (the caller treats Err as
    // best-effort and leaves crop_path unset). Intersect in point space.
    let ox = elem.x.max(win.x);
    let oy = elem.y.max(win.y);
    let ox2 = (elem.x + elem.w).min(win.x + win.w);
    let oy2 = (elem.y + elem.h).min(win.y + win.h);
    if ox2 - ox < 1.0 || oy2 - oy < 1.0 {
        bail!("element {:?} does not overlap window {:?}", elem, win);
    }
    // Per-axis device-pixels/point. On a single Retina display these are equal,
    // but deriving both means an asymmetric shadow strip / backing-store vs CG
    // bounds mismatch on one axis can't silently skew the other.
    let scale_x = img_w as f64 / win.w;
    let scale_y = img_h as f64 / win.h;
    // Edge-based rounding: round the origin and the far edge independently, then
    // take size = edge - origin. This keeps the right/bottom edge consistent with
    // the rounded origin (avoids the ±1px drift of rounding origin and size
    // separately) — matters for tight per-icon sprite crops.
    let x0 = ((elem.x - win.x).max(0.0) * scale_x).round() as i64;
    let y0 = ((elem.y - win.y).max(0.0) * scale_y).round() as i64;
    let x1 = ((elem.x + elem.w - win.x).max(0.0) * scale_x).round() as i64;
    let y1 = ((elem.y + elem.h - win.y).max(0.0) * scale_y).round() as i64;
    let cx = x0.clamp(0, img_w as i64 - 1) as u32;
    let cy = y0.clamp(0, img_h as i64 - 1) as u32;
    let cw = ((x1 - x0).max(1) as u32).min(img_w - cx);
    let ch = ((y1 - y0).max(1) as u32).min(img_h - cy);
    let cropped = img.crop_imm(cx, cy, cw, ch);
    cropped
        .save(out_path)
        .with_context(|| format!("writing crop {}", out_path.display()))?;
    Ok(())
}

/// Non-macOS fallback: region capture (no window-id / overlay immunity).
#[cfg(not(target_os = "macos"))]
pub fn capture_window_crop(
    _window_id: u32,
    _win: ScreenRect,
    elem: ScreenRect,
    out_path: &Path,
) -> Result<()> {
    capture_region(elem, out_path)
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
