//! Per-element screenshot. macOS uses the built-in `/usr/sbin/screencapture -R`;
//! Windows uses a `BitBlt` from the desktop DC (Phase 3 stub for now).

use crate::capture::ScreenRect;
use anyhow::{bail, Context, Result};
use std::path::Path;

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
