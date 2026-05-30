//! .NET XAML extractor (Phase 2.5 — rank 3).
//!
//! Shells out to `ilspycmd` (the ICSharpCode ILSpy CLI). The user must have it
//! installed: `dotnet tool install -g ilspycmd`. We auto-detect availability;
//! if it's missing the dispatcher falls back to AX/UIA.

use anyhow::{Context, Result};
use std::path::Path;
use std::process::Command;

/// Return true if `ilspycmd` is on PATH.
pub fn is_available() -> bool {
    Command::new("ilspycmd")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Run `ilspycmd <assembly> -o <out_dir>` to decompile a .NET binary to C#/XAML.
/// Returns the directory containing the recovered source.
pub fn decompile(assembly: &Path, out_dir: &Path) -> Result<()> {
    std::fs::create_dir_all(out_dir).context("creating ilspycmd out_dir")?;
    let status = Command::new("ilspycmd")
        .arg(assembly)
        .arg("-o")
        .arg(out_dir)
        .status()
        .context("invoking ilspycmd")?;
    if !status.success() {
        anyhow::bail!("ilspycmd exited {:?}", status.code());
    }
    Ok(())
}

/// Given a decompiled directory, return a flat list of recovered `.xaml` files.
pub fn find_xaml_files(dir: &Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    walk(dir, &mut out);
    out
}

fn walk(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(&p, out);
            } else if p.extension().and_then(|s| s.to_str()) == Some("xaml") {
                out.push(p);
            }
        }
    }
}
