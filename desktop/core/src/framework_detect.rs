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

    // Look for `.nib` / `.storyboardc` — strong signal for AppKit.
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

    // Fallback: peek at the Mach-O binary's load commands via goblin.
    // Looks for `LC_LOAD_DYLIB` referencing well-known frameworks.
    if let Ok(bytes) = std::fs::read(executable) {
        if let Ok(mach) = goblin::Object::parse(&bytes) {
            if let goblin::Object::Mach(m) = mach {
                let libs = collect_macho_dylibs(&m);
                if libs.iter().any(|l| l.contains("Electron Framework")) {
                    return Framework::Electron;
                }
                if libs.iter().any(|l| l.starts_with("@rpath/QtCore") || l.contains("QtCore.framework")) {
                    return Framework::Qt;
                }
                if libs.iter().any(|l| l.contains("AppKit.framework")) {
                    return Framework::AppKitNative;
                }
            }
        }
    }

    Framework::Unknown
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
