//! Electron `.asar` extractor skeleton (Phase 2 — rank 1).
//!
//! Locates `app.asar` in an Electron bundle and parses its header. Full
//! "extract → spin up headless Chromium → match the live AX element" pipeline
//! is **NOT** implemented yet — see the TODO list below. For now we surface
//! whether `app.asar` exists so the dispatcher can decide to fall back to
//! CDP / AX.
//!
//! TODO (full implementation):
//! 1. Parse asar header (pickle format: u32 LE size + JSON manifest)
//! 2. Extract files via offsets in the manifest
//! 3. Find the entry HTML in `package.json#main` → `BrowserWindow.loadFile` arg
//! 4. Spawn headless Chromium via `chromiumoxide` with that file
//! 5. Pass the live AX path of the picked element into the headless renderer
//!    via a JS bootstrap; walk the source DOM by role/text matching to locate
//!    the equivalent node; inject `contentScript.js` and run EXPORT_SELECTION

use anyhow::Result;
use std::path::{Path, PathBuf};

pub fn find_asar_for_executable(executable: &Path) -> Option<PathBuf> {
    // macOS: <bundle>.app/Contents/Resources/app.asar
    if cfg!(target_os = "macos") {
        let root = executable.parent()?.parent()?.parent()?; // MacOS → Contents → bundle
        let asar = root.join("Contents").join("Resources").join("app.asar");
        if asar.exists() {
            return Some(asar);
        }
    }
    // Windows: <install>\resources\app.asar (sibling of the .exe)
    if cfg!(target_os = "windows") {
        let parent = executable.parent()?;
        let asar = parent.join("resources").join("app.asar");
        if asar.exists() {
            return Some(asar);
        }
    }
    None
}

/// Read the asar header (JSON manifest of contents). Returns the parsed JSON.
pub fn read_asar_header(asar: &Path) -> Result<serde_json::Value> {
    use std::io::Read;
    let mut f = std::fs::File::open(asar)?;
    // asar pickle-style header:
    //   [0..4] = u32 LE = 4 (always)
    //   [4..8] = u32 LE = header_size + 8
    //   [8..12] = u32 LE = header_size + 4
    //   [12..16] = u32 LE = header_string_length
    //   [16..16+len] = JSON header
    let mut prefix = [0u8; 16];
    f.read_exact(&mut prefix)?;
    let header_str_len = u32::from_le_bytes([prefix[12], prefix[13], prefix[14], prefix[15]]) as usize;
    let mut header_bytes = vec![0u8; header_str_len];
    f.read_exact(&mut header_bytes)?;
    // Trim trailing alignment NULs.
    while header_bytes.last() == Some(&0u8) {
        header_bytes.pop();
    }
    let v: serde_json::Value = serde_json::from_slice(&header_bytes)?;
    Ok(v)
}
