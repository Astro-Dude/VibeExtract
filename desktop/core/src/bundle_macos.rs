//! macOS bundle-resource extractor (strategy rank 4).
//!
//! Walks `<App>.app/Contents/Resources/`, calling Apple-shipped CLI tools:
//!   - `ibtool --hierarchy` for `.nib` / `.storyboardc`
//!   - `assetutil --info` for `Assets.car`
//!   - The `plist` crate for `Info.plist`
//!
//! Produces a summary that the dispatcher merges with the AX-recovered
//! structure, so we end up with native-app HTML where colors / fonts come
//! from the source NIB rather than only pixel-sampling.

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

#[derive(Debug, Default, Clone)]
pub struct BundleSummary {
    pub bundle_id: Option<String>,
    pub display_name: Option<String>,
    pub executable_name: Option<String>,
    pub nibs: Vec<NibFile>,
    pub assets_car_summary: Option<String>,
    pub diagnostics: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct NibFile {
    pub name: String,
    /// Output of `ibtool --hierarchy <nib>` (XML). May be empty if ibtool failed.
    pub hierarchy_xml: String,
}

/// Find the `.app` bundle containing the given executable path.
pub fn bundle_root_for_executable(executable: &Path) -> Option<PathBuf> {
    // executable looks like `/Applications/Foo.app/Contents/MacOS/Foo`
    executable
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .map(|p| p.to_path_buf())
}

pub fn extract_bundle_summary(executable: &Path) -> Result<BundleSummary> {
    let Some(bundle) = bundle_root_for_executable(executable) else {
        return Ok(BundleSummary {
            diagnostics: vec!["couldn't locate .app bundle for executable".into()],
            ..Default::default()
        });
    };
    let contents = bundle.join("Contents");
    let mut summary = BundleSummary::default();

    // --- Info.plist ---
    let plist_path = contents.join("Info.plist");
    if plist_path.exists() {
        match plist::Value::from_file(&plist_path) {
            Ok(plist::Value::Dictionary(dict)) => {
                summary.bundle_id = dict
                    .get("CFBundleIdentifier")
                    .and_then(|v| v.as_string())
                    .map(|s| s.to_string());
                summary.display_name = dict
                    .get("CFBundleDisplayName")
                    .or_else(|| dict.get("CFBundleName"))
                    .and_then(|v| v.as_string())
                    .map(|s| s.to_string());
                summary.executable_name = dict
                    .get("CFBundleExecutable")
                    .and_then(|v| v.as_string())
                    .map(|s| s.to_string());
            }
            Ok(_) => summary
                .diagnostics
                .push("Info.plist top-level wasn't a dict".into()),
            Err(e) => summary
                .diagnostics
                .push(format!("Info.plist parse error: {}", e)),
        }
    } else {
        summary
            .diagnostics
            .push("no Info.plist in Contents/".into());
    }

    // --- NIB / storyboardc files via ibtool ---
    let resources = contents.join("Resources");
    if resources.exists() {
        if let Ok(entries) = std::fs::read_dir(&resources) {
            for entry in entries.flatten() {
                let path = entry.path();
                let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                    continue;
                };
                if name.ends_with(".nib") || name.ends_with(".storyboardc") {
                    match run_ibtool_hierarchy(&path) {
                        Ok(xml) => summary.nibs.push(NibFile {
                            name: name.to_string(),
                            hierarchy_xml: xml,
                        }),
                        Err(e) => summary
                            .diagnostics
                            .push(format!("ibtool failed on {}: {}", name, e)),
                    }
                }
            }
        }

        // --- Assets.car via assetutil ---
        let car = resources.join("Assets.car");
        if car.exists() {
            match run_assetutil_info(&car) {
                Ok(json) => summary.assets_car_summary = Some(json),
                Err(e) => summary
                    .diagnostics
                    .push(format!("assetutil failed: {}", e)),
            }
        }
    }

    Ok(summary)
}

fn run_ibtool_hierarchy(nib: &Path) -> Result<String> {
    let out = std::process::Command::new("/usr/bin/xcrun")
        .args(["ibtool", "--hierarchy"])
        .arg(nib)
        .output()
        .context("invoking xcrun ibtool")?;
    if !out.status.success() {
        anyhow::bail!(
            "ibtool exit {:?}: {}",
            out.status.code(),
            String::from_utf8_lossy(&out.stderr)
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn run_assetutil_info(car: &Path) -> Result<String> {
    let out = std::process::Command::new("/usr/bin/assetutil")
        .args(["--info"])
        .arg(car)
        .output()
        .context("invoking assetutil")?;
    if !out.status.success() {
        anyhow::bail!(
            "assetutil exit {:?}: {}",
            out.status.code(),
            String::from_utf8_lossy(&out.stderr)
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}
