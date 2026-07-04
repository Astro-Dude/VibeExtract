//! Detect what UI framework a process is using by inspecting its binary
//! on disk. Output drives the strategy ladder dispatch.

use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Framework {
    /// Electron / Chromium-based — try asar then CDP.
    Electron,
    /// .NET (WPF / WinUI / WinForms) — try ILSpy decomp.
    DotNet,
    /// Qt — try resource extraction.
    Qt,
    /// Native AppKit / Cocoa — try NIB extraction then AX fallback.
    AppKitNative,
    /// Native Win32 / WinUI without managed bits — try PE resource walk.
    Win32Native,
    /// Couldn't probe — use AX/UIA fallback.
    Unknown,
}

/// Detect the framework of an app from its executable / bundle on disk.
/// `path` should be the executable path returned by [`crate::ax_macos::pick`]
/// (e.g. `/Applications/Foo.app/Contents/MacOS/Foo` on Mac, `C:\Path\Foo.exe`
/// on Windows).
pub fn detect(path: &Path) -> Framework {
    if !path.exists() {
        return Framework::Unknown;
    }

    #[cfg(target_os = "macos")]
    {
        return detect_macos(path);
    }

    #[cfg(target_os = "windows")]
    {
        return detect_windows(path);
    }

    #[allow(unreachable_code)]
    Framework::Unknown
}

#[cfg(target_os = "macos")]
fn detect_macos(executable: &Path) -> Framework {
    // The bundle root is two parents up from Contents/MacOS/Foo
    let bundle_root = executable
        .parent() // MacOS
        .and_then(|p| p.parent()) // Contents
        .and_then(|p| p.parent()); // Foo.app
    let Some(bundle) = bundle_root else {
        return Framework::Unknown;
    };

    let frameworks_dir = bundle.join("Contents").join("Frameworks");
    if frameworks_dir.exists() {
        if frameworks_dir.join("Electron Framework.framework").exists() {
            return Framework::Electron;
        }
        // A *top-level* CEF framework means a Chromium-embedded app whose web
        // content is CDP-reachable — treat it like Electron. Deliberately NOT
        // recursive: hybrids like WPS ship a CEF *addon* deep under
        // Frameworks/office6/addons/cef while their actual shell is Qt, so a
        // recursive search would misclassify the Qt app as Chromium.
        if frameworks_dir
            .join("Chromium Embedded Framework.framework")
            .exists()
        {
            return Framework::Electron;
        }
        // Some Electron apps rename the framework.
        if let Ok(entries) = std::fs::read_dir(&frameworks_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_lowercase();
                if name.contains("electron") {
                    return Framework::Electron;
                }
                if name.starts_with("qtcore") || name.starts_with("qt5") || name.starts_with("qt6") {
                    return Framework::Qt;
                }
            }
        }
    }

    let resources_dir = bundle.join("Contents").join("Resources");
    if resources_dir.join("app.asar").exists() {
        return Framework::Electron;
    }

    // Inspect the executable's OWN Mach-O load commands — the most reliable
    // signal, because it reflects what *this* process links rather than what
    // the bundle happens to ship. Runs BEFORE the `.nib` heuristic so a hybrid
    // app that links Qt *and* carries nibs (e.g. a Qt shell with an AppKit
    // share extension, like WPS) is classed Qt, not AppKit.
    if let Ok(bytes) = std::fs::read(executable) {
        if let Ok(goblin::Object::Mach(m)) = goblin::Object::parse(&bytes) {
            let libs = collect_macho_dylibs(&m);
            if let Some(fw) = classify_dylibs(&libs) {
                return fw;
            }
            // Fat / multi-arch binaries yield no libs above (goblin's fat-slice
            // API is version-unstable). dylib load paths are stored as plain
            // ASCII, so fall back to a bounded raw-bytes scan for the same
            // framework signatures.
            if libs.is_empty() {
                if let Some(fw) = classify_macho_bytes(&bytes) {
                    return fw;
                }
            }
        }
    }

    // Fallback: `.nib` / `.storyboardc` in Resources -> AppKit. Only reached
    // when the Mach-O probe above was inconclusive.
    if resources_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&resources_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.ends_with(".nib") || name.ends_with(".storyboardc") {
                    return Framework::AppKitNative;
                }
            }
        }
    }

    Framework::Unknown
}

/// Classify a list of linked dylib paths into a [`Framework`]. CEF/Chromium is
/// checked before Qt so a binary that links both (a Chromium view embedded in a
/// Qt shell) is treated as web/CDP-capable rather than plain Qt.
#[cfg(target_os = "macos")]
fn classify_dylibs(libs: &[String]) -> Option<Framework> {
    if libs.iter().any(|l| l.contains("Electron Framework")) {
        return Some(Framework::Electron);
    }
    if libs
        .iter()
        .any(|l| l.contains("Chromium Embedded Framework") || l.contains("libcef"))
    {
        return Some(Framework::Electron);
    }
    if libs
        .iter()
        .any(|l| l.starts_with("@rpath/QtCore") || l.contains("QtCore"))
    {
        return Some(Framework::Qt);
    }
    if libs.iter().any(|l| l.contains("AppKit.framework")) {
        return Some(Framework::AppKitNative);
    }
    None
}

/// Raw-bytes fallback for fat/multi-arch Mach-O, where [`collect_macho_dylibs`]
/// returns nothing. Searches the (bounded) head of the file for the same dylib
/// path signatures `classify_dylibs` looks for — load commands live near each
/// slice's start, and both arch slices link the same frameworks, so the first
/// slice is sufficient.
#[cfg(target_os = "macos")]
fn classify_macho_bytes(bytes: &[u8]) -> Option<Framework> {
    let scan = &bytes[..bytes.len().min(16 * 1024 * 1024)];
    let has = |needle: &str| find_subslice(scan, needle.as_bytes());
    if has("Electron Framework") {
        return Some(Framework::Electron);
    }
    if has("Chromium Embedded Framework") || has("libcef") {
        return Some(Framework::Electron);
    }
    if has("QtCore") {
        return Some(Framework::Qt);
    }
    if has("AppKit.framework") {
        return Some(Framework::AppKitNative);
    }
    None
}

#[cfg(target_os = "macos")]
fn find_subslice(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || haystack.len() < needle.len() {
        return false;
    }
    haystack.windows(needle.len()).any(|w| w == needle)
}

#[cfg(target_os = "macos")]
fn collect_macho_dylibs(mach: &goblin::mach::Mach) -> Vec<String> {
    let mut out = Vec::new();
    if let goblin::mach::Mach::Binary(b) = mach {
        for lib in &b.libs {
            out.push(lib.to_string());
        }
    }
    // Fat (multi-arch) binaries: we skip per-slice parsing here because the
    // goblin API for iterating fat slices varies between versions. Detection
    // for fat binaries instead relies on the bundle / framework-folder checks
    // earlier in `detect_macos`, which cover all real-world Electron / Qt /
    // AppKit apps.
    out
}

#[cfg(target_os = "windows")]
fn detect_windows(executable: &Path) -> Framework {
    // Read PE imports + check for `resources\app.asar` sibling for Electron.
    if let Some(parent) = executable.parent() {
        let asar = parent.join("resources").join("app.asar");
        if asar.exists() {
            return Framework::Electron;
        }
    }

    if let Ok(bytes) = std::fs::read(executable) {
        if let Ok(goblin::Object::PE(pe)) = goblin::Object::parse(&bytes) {
            let imports: Vec<String> = pe
                .imports
                .iter()
                .map(|i| i.dll.to_string().to_lowercase())
                .collect();
            if imports
                .iter()
                .any(|d| d == "mscoree.dll" || d == "coreclr.dll" || d == "hostfxr.dll")
            {
                return Framework::DotNet;
            }
            if imports.iter().any(|d| d.starts_with("qt5") || d.starts_with("qt6")) {
                return Framework::Qt;
            }
            if imports.iter().any(|d| d.contains("node") || d.contains("chrome_elf")) {
                return Framework::Electron;
            }
            return Framework::Win32Native;
        }
    }
    Framework::Unknown
}
