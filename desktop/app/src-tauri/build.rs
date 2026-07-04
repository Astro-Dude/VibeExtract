use std::path::Path;

/// Recursively copy a dir, skipping python/OS cruft.
fn copy_dir(src: &Path, dst: &Path) {
    if !src.exists() {
        return;
    }
    let _ = std::fs::create_dir_all(dst);
    if let Ok(rd) = std::fs::read_dir(src) {
        for entry in rd.flatten() {
            let name = entry.file_name();
            let n = name.to_string_lossy();
            if n == "__pycache__" || n.ends_with(".pyc") || n == ".DS_Store" {
                continue;
            }
            let from = entry.path();
            let to = dst.join(&name);
            if from.is_dir() {
                copy_dir(&from, &to);
            } else {
                let _ = std::fs::copy(&from, &to);
            }
        }
    }
}

fn main() {
    // Stage the /replicate-ui Claude Code skill INTO this crate's resources/ so Tauri bundles it
    // inside the .app (bundle.resources). The app then self-installs it to ~/.claude/skills on launch.
    let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let skills_src = Path::new(&manifest).join("../../../.claude/skills");
    let res = Path::new(&manifest).join("resources");
    for s in ["replicate-ui", "replicate-ui-watch"] {
        let src = skills_src.join(s);
        if src.exists() {
            let _ = std::fs::remove_dir_all(res.join(s)); // refresh so deleted files don't linger
            copy_dir(&src, &res.join(s));
        }
    }
    println!("cargo:rerun-if-changed=../../../.claude/skills/replicate-ui");
    println!("cargo:rerun-if-changed=../../../.claude/skills/replicate-ui-watch");

    tauri_build::build()
}
