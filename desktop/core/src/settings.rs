//! Persistent user preferences. Single JSON file at
//! `~/Library/Application Support/VibeExtract/settings.json` (macOS) or
//! `~/.config/VibeExtract/settings.json` (other platforms).
//!
//! Tolerant on read — missing or malformed file returns `Default`. Atomic on
//! write — temp file + rename so a crashed write never leaves a half-baked
//! JSON. No external dep beyond what's already in the workspace.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ElectronRelaunchPref {
    /// Pop the confirmation dialog before quitting + relaunching.
    Ask,
    /// Quit + relaunch automatically without prompting.
    AlwaysYes,
    /// Never relaunch — fall straight through to the AX path.
    AlwaysNo,
}

impl Default for ElectronRelaunchPref {
    fn default() -> Self {
        Self::Ask
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct VibeExtractSettings {
    /// Per-app preference, keyed by bundle id (e.g. `com.tinyspeck.slackmacgap`).
    /// Bundle ids not present default to `Ask`.
    #[serde(default)]
    pub electron_relaunch: HashMap<String, ElectronRelaunchPref>,
}

fn settings_dir() -> PathBuf {
    let home = std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));
    #[cfg(target_os = "macos")]
    {
        home.join("Library")
            .join("Application Support")
            .join("VibeExtract")
    }
    #[cfg(not(target_os = "macos"))]
    {
        home.join(".config").join("VibeExtract")
    }
}

pub fn settings_path() -> PathBuf {
    settings_dir().join("settings.json")
}

/// Read settings from disk. Missing/corrupt files return `Default`.
pub fn load() -> VibeExtractSettings {
    let path = settings_path();
    let Ok(bytes) = std::fs::read(&path) else {
        return VibeExtractSettings::default();
    };
    match serde_json::from_slice::<VibeExtractSettings>(&bytes) {
        Ok(s) => s,
        Err(e) => {
            log::warn!(
                "settings.json at {} is malformed ({}) — falling back to defaults",
                path.display(),
                e
            );
            VibeExtractSettings::default()
        }
    }
}

/// Persist settings atomically: write to a temp file in the same directory,
/// fsync, then rename over the destination so a crashed write can't leave a
/// half-baked JSON behind.
pub fn save(s: &VibeExtractSettings) -> anyhow::Result<()> {
    let dir = settings_dir();
    std::fs::create_dir_all(&dir)?;
    let final_path = dir.join("settings.json");
    let tmp_path = dir.join(format!("settings.json.tmp.{}", std::process::id()));
    let json = serde_json::to_vec_pretty(s)?;
    {
        let mut f = std::fs::File::create(&tmp_path)?;
        f.write_all(&json)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp_path, &final_path)?;
    Ok(())
}

pub fn get_electron_pref(bundle_id: &str) -> ElectronRelaunchPref {
    load()
        .electron_relaunch
        .get(bundle_id)
        .copied()
        .unwrap_or_default()
}

pub fn set_electron_pref(bundle_id: &str, pref: ElectronRelaunchPref) -> anyhow::Result<()> {
    let mut s = load();
    s.electron_relaunch.insert(bundle_id.to_string(), pref);
    save(&s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pref_roundtrip_via_json() {
        let mut s = VibeExtractSettings::default();
        s.electron_relaunch
            .insert("com.tinyspeck.slackmacgap".into(), ElectronRelaunchPref::AlwaysYes);
        let json = serde_json::to_string(&s).unwrap();
        let parsed: VibeExtractSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(
            parsed.electron_relaunch.get("com.tinyspeck.slackmacgap"),
            Some(&ElectronRelaunchPref::AlwaysYes)
        );
    }

    #[test]
    fn missing_field_uses_default() {
        let parsed: VibeExtractSettings = serde_json::from_str("{}").unwrap();
        assert!(parsed.electron_relaunch.is_empty());
    }
}
