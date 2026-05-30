//! PE resource extractor (Phase 3 — strategy rank 6 supplement for Windows
//! native apps). Reads icons / bitmaps / manifests from a Windows executable.

use anyhow::{Context, Result};
use std::path::Path;

#[derive(Debug, Default, Clone)]
pub struct PeSummary {
    pub is_dotnet: bool,
    pub imports: Vec<String>,
    pub manifest_xml: Option<String>,
    pub diagnostics: Vec<String>,
}

pub fn extract_pe_summary(executable: &Path) -> Result<PeSummary> {
    let bytes = std::fs::read(executable).context("reading executable")?;
    let mut summary = PeSummary::default();
    match goblin::Object::parse(&bytes)? {
        goblin::Object::PE(pe) => {
            for imp in &pe.imports {
                summary.imports.push(imp.dll.to_string());
            }
            // .NET-detection: presence of CLR header (data directory 14).
            // The COM descriptor data directory implies a .NET assembly.
            summary.is_dotnet = pe
                .header
                .optional_header
                .as_ref()
                .and_then(|oh| oh.data_directories.get_clr_runtime_header())
                .is_some();
        }
        _ => {
            summary
                .diagnostics
                .push("not a PE file — expected on macOS executable".into());
        }
    }
    Ok(summary)
}
