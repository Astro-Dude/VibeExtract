//! Strategy-ladder dispatch. Given a picked element, try strategies in
//! fidelity order and return the first successful [`CaptureResult`].
//!
//! ```text
//! Picked element
//!     │
//!     ▼
//! Framework probe (Electron / .NET / Qt / AppKit / Win32)
//!     │
//!     ▼
//! ① asar (Electron) ──── if app.asar present and headless renderer can match
//!     │      (TODO: full element-matching not wired yet)
//!     ▼
//! ② CDP (Electron) ──── if --remote-debugging-port is open
//!     │
//!     ▼
//! ③ .NET XAML  ──── if PE has CLR header + ilspycmd installed
//!     │     (Windows path; mac falls through)
//!     ▼
//! ④ macOS bundle resources ──── if .app has Info.plist + nibs (mac only)
//!     │     (merged with ⑥ output below for higher fidelity)
//!     ▼
//! ⑤ Qt resources ──── (not implemented yet — stub)
//!     │
//!     ▼
//! ⑥ AX/UIA + pixel sampling ──── always works on any app with accessibility
//!     │
//!     ▼
//! ⑦ Screenshot-only ──── last-ditch fallback
//! ```

use crate::capture::PickedElement;
use crate::framework_detect::{detect, Framework};
use crate::output::CaptureResult;
use serde::{Deserialize, Serialize};
use std::path::Path;
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Strategy {
    Asar,
    Cdp,
    DotNetXaml,
    MacosBundle,
    QtResources,
    NativeAx,
    ScreenshotOnly,
}

#[derive(Debug, Error)]
pub enum ExtractError {
    #[error("AX permission denied — grant Accessibility access in System Settings and retry.")]
    NoAxPermission,
    #[error("no extractor succeeded; last error: {0}")]
    AllStrategiesFailed(String),
    #[error("{0}")]
    Other(#[from] anyhow::Error),
}

/// Run the dispatcher. `content_script` is the verbatim contents of the
/// browser extension's `contentScript.js` (read by the caller and passed in).
pub async fn extract(
    picked: &PickedElement,
    content_script: &str,
    out_dir: &Path,
) -> Result<CaptureResult, ExtractError> {
    let app_path = picked
        .app_path
        .as_ref()
        .map(Path::new)
        .map(|p| p.to_path_buf());
    let framework = app_path
        .as_deref()
        .map(detect)
        .unwrap_or(Framework::Unknown);
    log::info!(
        "dispatcher: picked={} \"{}\", framework={:?}, app_path={:?}",
        picked.role,
        picked.name,
        framework,
        picked.app_path
    );

    let mut last_error = String::new();

    // ── ① asar (Electron) ─────────────────────────────────────────────────
    // The "extract source → headless render → match" pipeline isn't wired;
    // for now we just check existence so the dispatcher logs which strategies
    // were considered.
    if framework == Framework::Electron {
        if let Some(exe) = app_path.as_deref() {
            if let Some(asar) = crate::asar::find_asar_for_executable(exe) {
                log::info!("strategy ① asar: found {} (full pipeline TODO)", asar.display());
                // TODO: implement element-matching headless renderer. Falling through to CDP.
            }
        }
    }

    // ── ② CDP (Electron with debug port) ──────────────────────────────────
    if framework == Framework::Electron {
        if let Some(port) = crate::cdp::discover_port().await {
            log::info!("strategy ② cdp: probing port {}", port);
            // Compute viewport-local coords.
            if let Some(win) = picked.window_bounds {
                let win_local_x = picked.bounds.center().x - win.x;
                let win_local_y = picked.bounds.center().y - win.y;
                match crate::cdp::translate_via_metrics(port, win_local_x, win_local_y).await {
                    Ok((vx, vy)) => {
                        match crate::cdp::extract_at_viewport(port, 0, vx, vy, content_script).await {
                            Ok(mut result) => {
                                result.diagnostics.push(format!(
                                    "Auto-dispatched: framework={:?}, strategy=cdp@{}",
                                    framework, port
                                ));
                                return Ok(result);
                            }
                            Err(e) => {
                                log::warn!("strategy ② cdp failed: {e}");
                                last_error = format!("cdp: {e}");
                            }
                        }
                    }
                    Err(e) => {
                        log::warn!("strategy ② cdp metrics failed: {e}");
                        last_error = format!("cdp metrics: {e}");
                    }
                }
            }
        } else {
            log::info!("strategy ② cdp: no debug port found; falling through");
        }
    }

    // ── ③ .NET XAML (Windows .NET apps) ──────────────────────────────────
    #[cfg(target_os = "windows")]
    {
        if framework == Framework::DotNet && crate::dotnet_xaml::is_available() {
            log::info!("strategy ③ dotnet-xaml: ilspycmd available; decompiling");
            // TODO: full XAML cascade resolver. For now skip.
        }
    }

    // ── ④ macOS bundle resources + ⑥ AX (fused for native AppKit apps) ───
    #[cfg(target_os = "macos")]
    {
        let bundle_summary = app_path
            .as_deref()
            .and_then(|p| crate::bundle_macos::extract_bundle_summary(p).ok());
        match native_extract_macos(picked, out_dir, bundle_summary).await {
            Ok(r) => return Ok(r),
            Err(e) => {
                log::warn!("strategy ⑥ native_ax failed: {e}");
                last_error = format!("native_ax: {e}");
            }
        }
    }

    // ── ⑥ UIA (Windows) ───────────────────────────────────────────────────
    #[cfg(target_os = "windows")]
    {
        // TODO Phase 3: actual UIA dump. For now, fall through to screenshot.
        log::info!("strategy ⑥ uia: not implemented yet — falling through");
    }

    // ── ⑦ Screenshot-only fallback ────────────────────────────────────────
    log::warn!("all strategies failed; emitting screenshot-only fallback");
    let mut fallback = CaptureResult::empty(
        "screenshot_only",
        "Visual only — no structure recovered",
    );
    let png_path = out_dir.join("native-output.png");
    if let Err(e) = crate::screenshot::capture_region(picked.bounds, &png_path) {
        return Err(ExtractError::AllStrategiesFailed(format!(
            "{last_error}; screenshot: {e}"
        )));
    }
    fallback.diagnostics.push("All structural strategies failed.".into());
    fallback.diagnostics.push(format!("Last error: {last_error}"));
    Ok(fallback)
}

/// Run the dispatcher on each of N picked elements and merge their outputs.
/// Used for Cmd+Shift+E when multiple elements are selected.
///
/// Constraint: all elements must belong to the same pid (enforced at the
/// pick-session level — this function does NOT recheck).
pub async fn extract_multi(
    picked_set: &[PickedElement],
    content_script: &str,
    out_dir: &Path,
) -> Result<CaptureResult, ExtractError> {
    if picked_set.is_empty() {
        return Err(ExtractError::AllStrategiesFailed(
            "no elements selected".into(),
        ));
    }
    if picked_set.len() == 1 {
        return extract(&picked_set[0], content_script, out_dir).await;
    }

    let mut per_element: Vec<(PickedElement, CaptureResult)> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    for (i, p) in picked_set.iter().enumerate() {
        // Each element gets its own sub-directory under out_dir to avoid
        // screenshot path collisions.
        let sub = out_dir.join(format!("elem-{}", i));
        let _ = std::fs::create_dir_all(&sub);
        match extract(p, content_script, &sub).await {
            Ok(r) => per_element.push((p.clone(), r)),
            Err(e) => errors.push(format!("element {}: {}", i, e)),
        }
    }

    if per_element.is_empty() {
        return Err(ExtractError::AllStrategiesFailed(errors.join("; ")));
    }

    // Merge. We use the first element's strategy as the "primary" badge but
    // call out the count.
    let primary_strategy = per_element[0].1.strategy.clone();
    let primary_fidelity = per_element[0].1.fidelity.clone();
    let merged_toon = merge_toon(&per_element);
    let merged_html = merge_html(&per_element);
    let merged_diag: Vec<String> = per_element
        .iter()
        .enumerate()
        .flat_map(|(i, (p, r))| {
            let mut v = vec![format!("--- element {} ({}) ---", i + 1, p.role)];
            v.extend(r.diagnostics.clone());
            v
        })
        .chain(errors)
        .collect();

    Ok(CaptureResult {
        strategy: format!("{} (×{})", primary_strategy, per_element.len()),
        fidelity: primary_fidelity,
        toon: merged_toon,
        html: merged_html,
        screenshot_png_b64: per_element[0].1.screenshot_png_b64.clone(),
        diagnostics: merged_diag,
    })
}

fn merge_toon(items: &[(PickedElement, CaptureResult)]) -> String {
    let mut s = String::new();
    s.push_str(&format!(
        "# VibeExtract — multi-element capture ({} elements)\n\n",
        items.len()
    ));
    for (i, (p, r)) in items.iter().enumerate() {
        s.push_str(&format!(
            "## Element {} of {} — {} \"{}\"\n\n",
            i + 1,
            items.len(),
            p.role,
            p.name
        ));
        s.push_str(&r.toon);
        s.push_str("\n\n---\n\n");
    }
    s
}

fn merge_html(items: &[(PickedElement, CaptureResult)]) -> String {
    let mut sections = String::new();
    for (i, (p, r)) in items.iter().enumerate() {
        // Use a sandboxed iframe with `srcdoc` so each element's HTML keeps
        // its own styles, scripts, and toolbar — no nested-document weirdness.
        // We HTML-encode the inner HTML's quotes/ampersands so it can live in
        // an attribute value.
        let srcdoc = html_escape(&r.html);
        sections.push_str(&format!(
            r#"<section class="ve-elem" data-idx="{i}">
  <header class="ve-elem-header">
    <strong>Element {n} of {total}</strong>
    <span class="ve-elem-role">{role}</span>
    <span class="ve-elem-name">{name}</span>
  </header>
  <iframe class="ve-elem-frame" srcdoc="{srcdoc}" sandbox="allow-scripts allow-same-origin"></iframe>
</section>"#,
            i = i,
            n = i + 1,
            total = items.len(),
            role = html_escape(&p.role),
            name = html_escape(&p.name),
            srcdoc = srcdoc,
        ));
    }
    format!(
        r#"<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>VibeExtract — Multi-element Capture ({count} elements)</title>
  <style>
    html, body {{ margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #f0f0f3; }}
    .ve-multi-header {{ position: sticky; top: 0; z-index: 10; padding: 14px 24px; background: #1a1a2e; color: #f5f3ff; font-size: 14px; font-weight: 600; border-bottom: 1px solid rgba(255,255,255,0.08); }}
    .ve-elem {{ margin: 20px; background: #fff; border-radius: 12px; box-shadow: 0 4px 16px rgba(0,0,0,0.08); overflow: hidden; }}
    .ve-elem-header {{ display: flex; gap: 12px; padding: 12px 18px; background: #fafafa; border-bottom: 1px solid #e0e0e0; font-size: 13px; align-items: center; }}
    .ve-elem-role {{ color: #6366f1; font-family: ui-monospace, Menlo, monospace; font-size: 11px; padding: 3px 8px; background: rgba(99,102,241,0.08); border-radius: 4px; }}
    .ve-elem-name {{ color: #555; flex: 1; font-style: italic; }}
    .ve-elem-frame {{ display: block; width: 100%; height: 600px; border: 0; background: white; }}
  </style>
</head>
<body>
  <div class="ve-multi-header">VibeExtract — {count} elements captured</div>
  {sections}
</body>
</html>"#,
        count = items.len(),
        sections = sections
    )
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Extract the entire frontmost window — used for Cmd+Shift+X.
///
/// On macOS, walks the system-wide AX root to the focused application's first
/// window, then runs the standard dispatcher on that AXWindow as the "picked
/// element". The dispatcher will route through the same ladder (asar / CDP /
/// AX / etc).
#[cfg(target_os = "macos")]
pub async fn extract_frontmost_window(
    content_script: &str,
    out_dir: &Path,
) -> Result<CaptureResult, ExtractError> {
    use crate::ax_macos::{check_permission, current_cursor, element_at};

    if !check_permission(false) {
        return Err(ExtractError::NoAxPermission);
    }

    // Do all AX work in a nested scope so the (non-Send) AxElement handles are
    // dropped before we cross the await boundary.
    let picked = {
        let pt = current_cursor();
        let el = element_at(pt).ok_or_else(|| {
            ExtractError::AllStrategiesFailed(
                "no AX element at cursor — hover over the target window before pressing Cmd+Shift+X".into(),
            )
        })?;
        let window = el
            .enclosing_window()
            .ok_or_else(|| ExtractError::AllStrategiesFailed("no enclosing AXWindow".into()))?;
        let bounds = window
            .rect()
            .ok_or_else(|| ExtractError::AllStrategiesFailed("window has no bounds".into()))?;
        let name = window.str_attr("AXTitle").unwrap_or_default();
        let pid = window.pid().unwrap_or(-1);
        let app_path = pid_to_path_macos(pid);
        let window_title = window.str_attr("AXTitle");
        PickedElement {
            role: "AXWindow".into(),
            subrole: None,
            name,
            identifier: None,
            bounds,
            pid,
            app_path,
            window_title,
            window_bounds: Some(bounds),
        }
    };

    extract(&picked, content_script, out_dir).await
}

#[cfg(target_os = "macos")]
fn pid_to_path_macos(pid: i32) -> Option<String> {
    extern "C" {
        fn proc_pidpath(pid: i32, buffer: *mut std::ffi::c_void, buffersize: u32) -> i32;
    }
    const MAX: usize = 4096;
    if pid <= 0 {
        return None;
    }
    let mut buf: Vec<u8> = vec![0; MAX];
    let n =
        unsafe { proc_pidpath(pid, buf.as_mut_ptr() as *mut std::ffi::c_void, MAX as u32) };
    if n <= 0 {
        return None;
    }
    buf.truncate(n as usize);
    String::from_utf8(buf).ok()
}

#[cfg(not(target_os = "macos"))]
pub async fn extract_frontmost_window(
    _content_script: &str,
    _out_dir: &Path,
) -> Result<CaptureResult, ExtractError> {
    Err(ExtractError::AllStrategiesFailed(
        "extract_frontmost_window not implemented on this platform yet".into(),
    ))
}

#[cfg(target_os = "macos")]
async fn native_extract_macos(
    picked: &PickedElement,
    out_dir: &std::path::Path,
    bundle: Option<crate::bundle_macos::BundleSummary>,
) -> anyhow::Result<CaptureResult> {
    use crate::ax_macos::element_at;
    use crate::sampling::{collect_palette, fill_node_colors};
    use base64::Engine as _;

    std::fs::create_dir_all(out_dir)?;

    // Re-pick at the element's center (already-known bounds) so we have a
    // fresh handle to walk children.
    let center = picked.bounds.center();
    let root_el = element_at(center)
        .ok_or_else(|| anyhow::anyhow!("re-pick at center failed"))?;
    let mut node = crate::ax_macos::walk_node(&root_el, 12);

    let png_path = out_dir.join("native-output.png");
    crate::screenshot::capture_region(picked.bounds, &png_path)?;
    let img = image::open(&png_path)?.into_rgba8();
    fill_node_colors(&mut node, &img, picked.bounds);

    let mut palette = Vec::new();
    collect_palette(&node, &mut palette);

    let toon = crate::native_format::emit_toon(&node, &palette, picked, bundle.as_ref());
    let png_bytes = std::fs::read(&png_path)?;
    let png_b64 = base64::engine::general_purpose::STANDARD.encode(&png_bytes);
    let html = crate::native_format::emit_html(&node, &png_b64, picked.bounds);

    let fidelity = if bundle.as_ref().map(|b| !b.nibs.is_empty()).unwrap_or(false) {
        "Native AX + NIB-resolved + sampled colors".to_string()
    } else {
        "Native AX + sampled colors + screenshot".to_string()
    };

    let mut diag = vec![format!("Captured {} AX nodes", crate::ax_macos::count_nodes(&node))];
    if let Some(b) = bundle.as_ref() {
        diag.push(format!("Bundle: {} nibs, assets_car={}", b.nibs.len(), b.assets_car_summary.is_some()));
        for d in &b.diagnostics {
            diag.push(d.clone());
        }
    }

    Ok(CaptureResult {
        strategy: "native_ax".into(),
        fidelity,
        toon,
        html,
        screenshot_png_b64: Some(png_b64),
        diagnostics: diag,
    })
}
