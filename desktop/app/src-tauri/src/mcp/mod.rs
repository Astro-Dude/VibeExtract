//! Embedded MCP server for Echo.
//!
//! Exposes Echo's native inspection (AX tree, on-screen windows,
//! self-taken screenshots), the existing extraction ladder, and a visual diff
//! verifier as MCP tools that Claude drives directly to replicate desktop UIs.
//!
//! Transport: rmcp Streamable-HTTP served by axum on `127.0.0.1:<port>`, nested
//! at `/mcp`. Lifecycle is tied to the Tauri app: a `CancellationToken` in
//! [`McpServerState`] lets `mcp_toggle` stop (cancel) and start (re-bind) it.
//! Off by default — the user starts it from the app UI.

mod ax_bridge;
mod params;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, Content, Implementation, ServerCapabilities, ServerInfo};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{tool, tool_handler, tool_router, ErrorData, ServerHandler};
use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};
use tokio_util::sync::CancellationToken;

use base64::Engine as _;
use vibe_extract_core::capture::{ScreenPoint, ScreenRect};

use params::*;

/// Monotonic counter for naming saved screenshot files.
static SHOT_SEQ: AtomicU64 = AtomicU64::new(0);

// =============================================================================
// The MCP service + tool surface
// =============================================================================

#[derive(Clone)]
pub struct VibeExtractMcp {
    /// Where saved screenshots land (so Playwright/compare_images can reference
    /// them by path). The service is decoupled from `AppHandle` for testability;
    /// the live server attaches one via [`with_app`] so `show_replica` can push
    /// results to the app window.
    out_dir: std::path::PathBuf,
    /// Present only when served from the running app — lets UI-facing tools
    /// (`show_replica`) emit events to the webview. `None` in unit tests.
    app: Option<AppHandle>,
    tool_router: ToolRouter<VibeExtractMcp>,
}

impl VibeExtractMcp {
    pub fn new(out_dir: std::path::PathBuf) -> Self {
        Self {
            out_dir,
            app: None,
            tool_router: Self::tool_router(),
        }
    }

    /// Attach the Tauri app handle so UI-facing tools can drive the window.
    pub fn with_app(mut self, app: AppHandle) -> Self {
        self.app = Some(app);
        self
    }

    fn output_dir(&self) -> std::path::PathBuf {
        self.out_dir.clone()
    }

    /// Save a screenshot to the output dir (so the Playwright MCP / compare_images
    /// can reference it by path) AND return the inline image so Claude can see it.
    fn present_shot(
        &self,
        shot: vibe_extract_core::screenshot::ShotResult,
        label: &str,
    ) -> Result<CallToolResult, ErrorData> {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(shot.png_b64.as_bytes())
            .map_err(|e| ErrorData::internal_error(format!("decode screenshot: {e}"), None))?;
        let dir = self.output_dir();
        let _ = std::fs::create_dir_all(&dir);
        let seq = SHOT_SEQ.fetch_add(1, Ordering::Relaxed);
        let path = dir.join(format!("mcp-{label}-{seq}.png"));
        std::fs::write(&path, &bytes)
            .map_err(|e| ErrorData::internal_error(format!("write {}: {e}", path.display()), None))?;
        let dims = json!({
            "px_w": shot.px_w,
            "px_h": shot.px_h,
            "point_w": shot.point_w,
            "point_h": shot.point_h,
            "scale": shot.scale,
            "path": path.to_string_lossy(),
        });
        Ok(CallToolResult::success(vec![
            Content::image(shot.png_b64, "image/png"),
            Content::text(dims.to_string()),
        ]))
    }
}

#[tool_router]
impl VibeExtractMcp {
    #[tool(description = "Check whether macOS Accessibility permission is granted. AX tools require it.")]
    async fn check_ax_permission(&self) -> Result<CallToolResult, ErrorData> {
        ok_value(json!({ "trusted": ax_trusted() }))
    }

    #[tool(description = "Get the component(s) the user picked in the desktop app (press ⌘⇧S on the target app, then click an element; ⇧+click adds more). Returns the LAST pick's elements — role, name, bounds (points, top-left), pid, `app_path` (owning app's executable path), `subrole`, `identifier`, `window_title`, `window_bounds`, `click` (the exact {x,y} screen point clicked), `ax_shallow`, `crop_path`, and `ax_tree` — plus `age_seconds` (how long ago it was picked). `crop_path` is an absolute path to a PNG of the element captured AT PICK-TIME (cropped from the owning window, free of the pick overlay), so it stays valid even after the target app is closed/backgrounded — PREFER it as the native reference crop instead of a live screenshot_region (no need to keep the app on screen). It is null only if the pick-time capture failed. Each element also carries `ax_tree`: its FULL AX subtree (roles/names/values/bounds/children) captured AT PICK-TIME — PREFER it as the component's structure (and write it to `ax_tree.json`) instead of calling `ax_subtree_at_point`, which is a LIVE query needing the app still present. `ax_tree` is null for `ax_shallow`/Electron picks (use `extract_component`), for very large trees, or older records — only THEN fall back to the live `ax_subtree_at_point`. `age_seconds` is also the time since the last click — useful for debouncing multi-select (wait until it's ≥10 before acting). USE THIS at the start of /replicate-ui: if `present` is true, replicate ONLY the selected component(s); if false/empty, replicate the whole window. IMPORTANT: when an element's `ax_shallow` is true (or role is AXMenuBar/AXApplication/AXWindow), the native AX tree couldn't see the real element (typical for Electron apps like Slack/VS Code) — do NOT trust `bounds`/`role`; instead call `extract_component { x: click.x, y: click.y }` (the CDP→AX→screenshot ladder) to resolve the real element, and use its returned bounds for screenshot_region. Otherwise use `bounds` directly.")]
    async fn get_selection(&self) -> Result<CallToolResult, ErrorData> {
        let path = self.output_dir().join("last-selection.json");
        match std::fs::read_to_string(&path) {
            Ok(s) => {
                let elements: serde_json::Value =
                    serde_json::from_str(&s).unwrap_or_else(|_| json!([]));
                let count = elements.as_array().map(|a| a.len()).unwrap_or(0);
                let age_seconds = std::fs::metadata(&path)
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.elapsed().ok())
                    .map(|d| d.as_secs());
                ok_value(json!({
                    "present": count > 0,
                    "count": count,
                    "age_seconds": age_seconds,
                    "elements": elements,
                }))
            }
            Err(_) => ok_value(json!({ "present": false, "count": 0, "elements": [] })),
        }
    }

    #[tool(
        description = "Open System Settings → Privacy → Accessibility so the user can grant Echo access. Returns the current trusted state."
    )]
    async fn request_ax_permission(
        &self,
        Parameters(p): Parameters<RequestPermissionParam>,
    ) -> Result<CallToolResult, ErrorData> {
        let trusted = if p.prompt { ax_request() } else { ax_trusted() };
        ok_value(json!({ "trusted": trusted }))
    }

    #[tool(description = "Get the frontmost (focused) application's pid, executable path, and name.")]
    async fn frontmost_app(&self) -> Result<CallToolResult, ErrorData> {
        match ax_bridge::frontmost_app().await {
            Ok(v) => ok_value(v),
            Err(e) => tool_err(e),
        }
    }

    #[tool(
        description = "List on-screen windows (all apps, or one pid): pid, app_name, title, bounds (points), window_id, layer. Bounds feed screenshot_region directly."
    )]
    async fn list_windows(
        &self,
        Parameters(p): Parameters<ListWindowsParam>,
    ) -> Result<CallToolResult, ErrorData> {
        let pid = p.pid;
        let windows = tokio::task::spawn_blocking(move || {
            let mut w = vibe_extract_core::windows_list::list_windows();
            if let Some(pid) = pid {
                w.retain(|win| win.pid == pid);
            }
            w
        })
        .await
        .map_err(|e| ErrorData::internal_error(format!("list_windows task: {e}"), None))?;
        ok_value(json!({ "windows": windows }))
    }

    #[tool(
        description = "Walk the macOS Accessibility tree of an app from its root (or a single window via window_index). Returns roles, names, values, per-element bounds (points), and children. The component inventory for replication. max_depth defaults to 25."
    )]
    async fn ax_tree(
        &self,
        Parameters(p): Parameters<AxTreeParam>,
    ) -> Result<CallToolResult, ErrorData> {
        let depth = p.max_depth.unwrap_or(25);
        match ax_bridge::ax_tree(p.pid, depth, p.window_index).await {
            Ok(v) => ok_value(v),
            Err(e) => tool_err(e),
        }
    }

    #[tool(
        description = "Hit-test the deepest AX element at a screen point (points, top-left origin). Optionally restrict to a pid. Returns role, name, bounds, pid, and enclosing window."
    )]
    async fn ax_node_at_point(
        &self,
        Parameters(p): Parameters<PointParam>,
    ) -> Result<CallToolResult, ErrorData> {
        match ax_bridge::node_at_point(p.x, p.y, p.pid).await {
            Ok(v) => ok_value(v),
            Err(e) => tool_err(e),
        }
    }

    #[tool(description = "Walk the AX subtree rooted at the deepest element under a screen point. max_depth defaults to 25.")]
    async fn ax_subtree_at_point(
        &self,
        Parameters(p): Parameters<SubtreeParam>,
    ) -> Result<CallToolResult, ErrorData> {
        let depth = p.max_depth.unwrap_or(25);
        match ax_bridge::subtree_at_point(p.x, p.y, depth).await {
            Ok(v) => ok_value(v),
            Err(e) => tool_err(e),
        }
    }

    #[tool(
        description = "Screenshot a screen region (x,y,w,h in points, top-left origin). Returns the PNG as an image plus device pixel dimensions and the Retina scale (px/point) so you can reconcile against a CSS-pixel render."
    )]
    async fn screenshot_region(
        &self,
        Parameters(p): Parameters<RectParam>,
    ) -> Result<CallToolResult, ErrorData> {
        let bounds = ScreenRect { x: p.x, y: p.y, w: p.w, h: p.h };
        let shot = tokio::task::spawn_blocking(move || {
            vibe_extract_core::screenshot::capture_region_b64(bounds)
        })
        .await
        .map_err(|e| ErrorData::internal_error(format!("screenshot task: {e}"), None))?;
        match shot {
            Ok(shot) => self.present_shot(shot, "region"),
            Err(e) => tool_err(e.to_string()),
        }
    }

    #[tool(
        description = "Screenshot a window owned by pid (window_index into the on-screen window list, default the first). Returns PNG + dimensions + scale + saved file path. For pixel-tight crops, prefer ax_tree to get a node's bounds, then screenshot_region."
    )]
    async fn screenshot_window(
        &self,
        Parameters(p): Parameters<WindowShotParam>,
    ) -> Result<CallToolResult, ErrorData> {
        let pid = p.pid;
        let idx = p.window_index.unwrap_or(0);
        let shot = tokio::task::spawn_blocking(move || -> Result<_, String> {
            let win = vibe_extract_core::windows_list::list_windows()
                .into_iter()
                .filter(|w| w.pid == pid)
                .nth(idx)
                .ok_or_else(|| format!("no window #{idx} for pid {pid}"))?;
            vibe_extract_core::screenshot::capture_window_b64(&win).map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| ErrorData::internal_error(format!("screenshot task: {e}"), None))?;
        match shot {
            Ok(shot) => self.present_shot(shot, "window"),
            Err(e) => tool_err(e),
        }
    }

    #[tool(description = "Sample the on-screen RGB color at a single point (points, top-left origin).")]
    async fn sample_color(
        &self,
        Parameters(p): Parameters<SampleColorParam>,
    ) -> Result<CallToolResult, ErrorData> {
        let at = ScreenPoint { x: p.x, y: p.y };
        let rgb = tokio::task::spawn_blocking(move || vibe_extract_core::screenshot::sample_point(at))
            .await
            .map_err(|e| ErrorData::internal_error(format!("sample task: {e}"), None))?;
        match rgb {
            Ok((r, g, b)) => ok_value(json!({
                "rgb": [r, g, b],
                "hex": format!("#{:02x}{:02x}{:02x}", r, g, b),
            })),
            Err(e) => tool_err(e.to_string()),
        }
    }

    #[tool(description = "Sample a deduped color palette from an app's main window (AX node centers). max_depth defaults to 25.")]
    async fn color_palette(
        &self,
        Parameters(p): Parameters<PaletteParam>,
    ) -> Result<CallToolResult, ErrorData> {
        match ax_bridge::palette(p.pid, p.max_depth.unwrap_or(25)).await {
            Ok(v) => ok_value(v),
            Err(e) => tool_err(e),
        }
    }

    #[tool(
        description = "DESTRUCTIVE: quit and relaunch an Electron app with a Chromium debug port so high-fidelity DOM extraction works. Requires confirm=true (it closes the running app). Returns the debug port."
    )]
    async fn relaunch_with_debug_port(
        &self,
        Parameters(p): Parameters<RelaunchParam>,
    ) -> Result<CallToolResult, ErrorData> {
        if !p.confirm {
            return tool_err(
                "Refusing to relaunch: this quits and reopens the target app and could close \
                 unsaved work. Re-call with confirm=true to proceed.",
            );
        }
        let target = match vibe_extract_core::electron_relaunch::make_target(
            Some(&p.bundle_id),
            &p.display_name,
        ) {
            Ok(t) => t,
            Err(e) => return tool_err(e.to_string()),
        };
        match vibe_extract_core::electron_relaunch::quit_and_relaunch(&target, |_progress| {}).await {
            Ok(port) => ok_value(json!({
                "port": port,
                "cdp_url": format!("http://127.0.0.1:{port}/json"),
            })),
            Err(e) => tool_err(e.to_string()),
        }
    }

    #[tool(
        description = "Run Echo's full extraction ladder at a screen point: picks the element, then tries CDP (Electron) / native AX / screenshot. Returns a CaptureResult (strategy, fidelity, toon, html, screenshot). A high-fidelity head-start for the first HTML draft."
    )]
    async fn extract_component(
        &self,
        Parameters(p): Parameters<ExtractComponentParam>,
    ) -> Result<CallToolResult, ErrorData> {
        let picked = match ax_bridge::pick_element(p.x, p.y, p.pid).await {
            Ok(picked) => picked,
            Err(e) => return tool_err(e),
        };
        let out_dir = self.output_dir();
        match vibe_extract_core::dispatcher::extract_with_opts(
            &picked,
            crate::CONTENT_SCRIPT,
            &out_dir,
            p.skip_relaunch,
        )
        .await
        {
            Ok(cr) => {
                let mut content = vec![Content::text(
                    serde_json::to_string(&cr)
                        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?,
                )];
                if let Some(b64) = &cr.screenshot_png_b64 {
                    content.push(Content::image(b64.clone(), "image/png"));
                }
                Ok(CallToolResult::success(content))
            }
            Err(vibe_extract_core::dispatcher::ExtractError::ElectronNeedsRelaunch {
                bundle_id,
                display_name,
                ..
            }) => tool_err(format!(
                "This is an Electron app and its Chromium debug port isn't open. \
                 Call relaunch_with_debug_port with bundle_id=\"{bundle_id}\", \
                 display_name=\"{display_name}\", confirm=true, then retry — or pass \
                 skip_relaunch=true to settle for the shallow AX/screenshot path."
            )),
            Err(e) => tool_err(e.to_string()),
        }
    }

    #[tool(
        description = "Extract PIXEL-PERFECT real assets from a running Electron app via CDP — it must have been launched with --remote-debugging-port (use relaunch_with_debug_port if not). Harvests the app's icon font(s) + text fonts, the class→codepoint map for rendered icon glyphs, and every visible image/avatar (read straight from the renderer, or captured as a pixel-clip when a CDN blocks reads). Writes fonts to <out>/<subdir>/fonts and images to <out>/<subdir>/img, and returns a manifest: fonts[{family,weight,style,file}], icons[{className,codepoint,char,label,fontFamily}], images[{label,file,rect_points}]. Most apps (Slack, etc.) use an icon FONT not SVG — embed the woff2 + use the codepoints, and reference the saved image files, so the replica matches exactly."
    )]
    async fn extract_assets(
        &self,
        Parameters(p): Parameters<ExtractAssetsParam>,
    ) -> Result<CallToolResult, ErrorData> {
        let port = match vibe_extract_core::cdp::discover_port().await {
            Some(port) => port,
            None => {
                return tool_err(
                    "No Chromium debug port found on 9220–9230. The target must be an Electron \
                     app launched with --remote-debugging-port. Run relaunch_with_debug_port \
                     (confirm=true) first, then retry.",
                )
            }
        };
        let idx = p.target_index.unwrap_or(0);
        let manifest =
            match vibe_extract_core::cdp::harvest_assets(port, idx, crate::ASSET_HARVESTER).await {
                Ok(m) => m,
                Err(e) => return tool_err(format!("CDP asset harvest failed: {e}")),
            };

        let base = self
            .output_dir()
            .join(p.out_subdir.as_deref().unwrap_or("assets"));
        let fonts_dir = base.join("fonts");
        let img_dir = base.join("img");
        let _ = std::fs::create_dir_all(&fonts_dir);
        let _ = std::fs::create_dir_all(&img_dir);
        let dec = base64::engine::general_purpose::STANDARD;

        // ---- fonts (icon fonts + text fonts) ----
        let mut out_fonts = Vec::new();
        let mut used = std::collections::HashSet::new();
        if let Some(fonts) = manifest.get("fonts").and_then(|v| v.as_array()) {
            for f in fonts {
                let Some(b64) = f.get("base64").and_then(|v| v.as_str()) else { continue };
                let Ok(bytes) = dec.decode(b64.as_bytes()) else { continue };
                let family = f.get("family").and_then(|v| v.as_str()).unwrap_or("font");
                let weight = f.get("weight").and_then(|v| v.as_str()).unwrap_or("400");
                let style = f.get("style").and_then(|v| v.as_str()).unwrap_or("normal");
                let format = f.get("format").and_then(|v| v.as_str()).unwrap_or("woff2");
                let ext = match format {
                    "woff" => "woff",
                    "opentype" => "otf",
                    "truetype" => "ttf",
                    _ => "woff2",
                };
                let stem = format!("{}-{}-{}", slugify(family), weight, slugify(style));
                let mut name = stem.clone();
                let mut i = 1;
                while !used.insert(name.clone()) {
                    name = format!("{stem}-{i}");
                    i += 1;
                }
                let path = fonts_dir.join(format!("{name}.{ext}"));
                if std::fs::write(&path, &bytes).is_ok() {
                    out_fonts.push(json!({
                        "family": family, "weight": weight, "style": style, "format": format,
                        "file": path.to_string_lossy(), "bytes": bytes.len(),
                    }));
                }
            }
        }

        // ---- images (avatars, uploaded files, backgrounds) ----
        let mut out_images = Vec::new();
        let mut used_img = std::collections::HashSet::new();
        if let Some(images) = manifest.get("images").and_then(|v| v.as_array()) {
            for (i, im) in images.iter().enumerate() {
                let Some(b64) = im.get("base64").and_then(|v| v.as_str()) else { continue };
                let Ok(bytes) = dec.decode(b64.as_bytes()) else { continue };
                let label = im.get("label").and_then(|v| v.as_str()).unwrap_or("image");
                let mime = im.get("mime").and_then(|v| v.as_str()).unwrap_or("image/png");
                let ext = if mime.contains("jpeg") || mime.contains("jpg") {
                    "jpg"
                } else if mime.contains("gif") {
                    "gif"
                } else if mime.contains("webp") {
                    "webp"
                } else if mime.contains("svg") {
                    "svg"
                } else {
                    "png"
                };
                let stem = {
                    let s = slugify(label);
                    if s.is_empty() { format!("image-{i}") } else { s }
                };
                let mut name = stem.clone();
                let mut k = 1;
                while !used_img.insert(name.clone()) {
                    name = format!("{stem}-{k}");
                    k += 1;
                }
                let path = img_dir.join(format!("{name}.{ext}"));
                if std::fs::write(&path, &bytes).is_ok() {
                    out_images.push(json!({
                        "label": label,
                        "file": path.to_string_lossy(),
                        "rect_points": im.get("rect").cloned().unwrap_or(serde_json::Value::Null),
                        "via": im.get("via").and_then(|v| v.as_str()).unwrap_or("fetch"),
                        "bytes": bytes.len(),
                    }));
                }
            }
        }

        ok_value(json!({
            "port": port,
            "assets_dir": base.to_string_lossy(),
            "fonts": out_fonts,
            "images": out_images,
            "icons": manifest.get("icons").cloned().unwrap_or(json!([])),
            "warnings": manifest.get("warnings").cloned().unwrap_or(json!([])),
        }))
    }

    #[tool(
        description = "Visually compare two PNGs (native reference vs rendered replica), each given by file path (preferred) or base64. Resizes both to a common canvas (absorbs Retina scale), returns an SSIM-style score (0..1), MAE, mismatch fraction, a pass flag vs threshold (default 0.92), and a red diff heatmap PNG."
    )]
    async fn compare_images(
        &self,
        Parameters(p): Parameters<CompareImagesParam>,
    ) -> Result<CallToolResult, ErrorData> {
        let threshold = p.threshold.unwrap_or(0.92);
        let a = match load_image_arg("a", p.a_path, p.a_png_b64) {
            Ok(b) => b,
            Err(e) => return tool_err(e),
        };
        let b = match load_image_arg("b", p.b_path, p.b_png_b64) {
            Ok(b) => b,
            Err(e) => return tool_err(e),
        };
        let report = tokio::task::spawn_blocking(move || {
            vibe_extract_core::image_diff::compare_bytes(
                &a,
                &b,
                &vibe_extract_core::image_diff::DiffOptions::default(),
            )
        })
        .await
        .map_err(|e| ErrorData::internal_error(format!("compare task: {e}"), None))?;
        match report {
            Ok(report) => {
                let pass = report.score_0_1 >= threshold;
                let summary = json!({
                    "score": report.score_0_1,
                    "method": report.method,
                    "width": report.width,
                    "height": report.height,
                    "mean_abs_err": report.mean_abs_err,
                    "mismatch_fraction": report.mismatch_fraction,
                    "threshold": threshold,
                    "pass": pass,
                });
                Ok(CallToolResult::success(vec![
                    Content::text(summary.to_string()),
                    Content::image(report.diff_png_b64, "image/png"),
                ]))
            }
            Err(e) => tool_err(e.to_string()),
        }
    }

    #[tool(
        description = "Display a finished /replicate-ui extraction INSIDE the Echo app's result panel (Preview + HTML + AX Tree tabs) — the in-app alternative to serving the replica at a localhost URL. `dir` is the extraction output folder (holds index.html, optional ax_tree.json, and icons/assets). Reads index.html and INLINES its local assets so the preview is self-contained, reads ax_tree.json if present, pushes both to the app window, and brings it to the front. Call this at the end of a /replicate-ui run instead of starting an http.server."
    )]
    async fn show_replica(
        &self,
        Parameters(p): Parameters<ShowReplicaParam>,
    ) -> Result<CallToolResult, ErrorData> {
        let app = match &self.app {
            Some(a) => a,
            None => return tool_err("app handle unavailable — the MCP server isn't attached to a UI window"),
        };
        let dir = std::path::PathBuf::from(&p.dir);
        let index = dir.join("index.html");
        let raw = std::fs::read_to_string(&index)
            .map_err(|e| ErrorData::internal_error(format!("read {}: {e}", index.display()), None))?;
        let html = inline_replica_assets(&dir, &raw);
        let ax_tree = std::fs::read_to_string(dir.join("ax_tree.json")).ok();
        let title = dir
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("replica")
            .to_string();
        app.emit(
            "show-replica",
            json!({
                // Self-contained (assets inlined as data: URIs) — for the Preview iframe.
                "html": html,
                // Original source (relative asset paths, no base64) — the HTML tab
                // pretty-prints THIS as a readable, indented DOM (DevTools-style).
                "source": raw,
                "ax_tree": ax_tree,
                "title": title,
                "dir": dir.to_string_lossy(),
            }),
        )
        .map_err(|e| ErrorData::internal_error(format!("emit show-replica: {e}"), None))?;
        // Bring the app window forward so the result is visible immediately.
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.show();
            let _ = w.set_focus();
        }
        ok_value(json!({
            "shown": true,
            "dir": dir.to_string_lossy(),
            "ax_tree": ax_tree.is_some(),
            "note": "Replica is now in the app's result panel (Preview / HTML / AX Tree)."
        }))
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for VibeExtractMcp {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("echo", env!("CARGO_PKG_VERSION")))
            .with_instructions(
                "Echo exposes a running Mac's native UI for automated replication. \
                 Typical loop: check_ax_permission → frontmost_app/list_windows → ax_tree \
                 (component inventory with bounds) → screenshot_region/screenshot_window \
                 (your own reference shots; note the returned `scale` for Retina) → write \
                 plain self-contained HTML+CSS → render it with the Playwright MCP at the \
                 same point size → compare_images(native, replica) → iterate on the diff \
                 heatmap until score ≥ 0.92. Use extract_component for a high-fidelity \
                 head-start (especially Electron apps). All bounds are in points, top-left \
                 origin.",
            )
    }
}

// --- shared tool helpers -----------------------------------------------------

fn ok_value(v: serde_json::Value) -> Result<CallToolResult, ErrorData> {
    Ok(CallToolResult::success(vec![Content::text(v.to_string())]))
}

fn tool_err(msg: impl Into<String>) -> Result<CallToolResult, ErrorData> {
    Ok(CallToolResult::error(vec![Content::text(msg.into())]))
}

// --- replica asset inlining (for show_replica) -------------------------------
// The skill writes index.html referencing local files (icons/*.png, assets/…,
// fonts). To show it in an iframe `srcdoc` (no base URL), rewrite each local
// reference to a self-contained data: URI.

fn mime_for(path: &str) -> &'static str {
    let p = path.to_ascii_lowercase();
    if p.ends_with(".png") { "image/png" }
    else if p.ends_with(".jpg") || p.ends_with(".jpeg") { "image/jpeg" }
    else if p.ends_with(".svg") { "image/svg+xml" }
    else if p.ends_with(".gif") { "image/gif" }
    else if p.ends_with(".webp") { "image/webp" }
    else if p.ends_with(".woff2") { "font/woff2" }
    else if p.ends_with(".woff") { "font/woff" }
    else if p.ends_with(".ttf") { "font/ttf" }
    else if p.ends_with(".otf") { "font/otf" }
    else { "application/octet-stream" }
}

/// A relative local reference → data: URI, or None to leave it untouched
/// (absolute/remote/data URLs, or files that don't exist under `dir`).
fn data_uri(dir: &std::path::Path, rel: &str) -> Option<String> {
    let r = rel.trim();
    if r.is_empty()
        || r.starts_with("data:")
        || r.starts_with("http://")
        || r.starts_with("https://")
        || r.starts_with("//")
        || r.starts_with('/')
        || r.starts_with('#')
    {
        return None;
    }
    let clean = r.split(['?', '#']).next().unwrap_or(r);
    let bytes = std::fs::read(dir.join(clean)).ok()?;
    Some(format!(
        "data:{};base64,{}",
        mime_for(clean),
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    ))
}

/// Replace every `<delim>PATH<quote>` (e.g. `src="icons/x.png"`) whose PATH is a
/// local file with its data: URI.
fn replace_quoted(html: &str, delim: &str, dir: &std::path::Path) -> String {
    let quote = delim.chars().last().unwrap();
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(i) = rest.find(delim) {
        out.push_str(&rest[..i + delim.len()]);
        rest = &rest[i + delim.len()..];
        if let Some(end) = rest.find(quote) {
            let path = &rest[..end];
            out.push_str(&data_uri(dir, path).unwrap_or_else(|| path.to_string()));
            out.push(quote);
            rest = &rest[end + quote.len_utf8()..];
        } else {
            break;
        }
    }
    out.push_str(rest);
    out
}

/// Replace CSS `url(PATH)` (optionally quoted) local refs with data: URIs.
fn replace_css_urls(html: &str, dir: &std::path::Path) -> String {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(i) = rest.find("url(") {
        out.push_str(&rest[..i + 4]);
        rest = &rest[i + 4..];
        let (skip, close): (usize, char) = match rest.chars().next() {
            Some('"') => (1, '"'),
            Some('\'') => (1, '\''),
            _ => (0, ')'),
        };
        out.push_str(&rest[..skip]);
        rest = &rest[skip..];
        if let Some(end) = rest.find(close) {
            let path = &rest[..end];
            out.push_str(&data_uri(dir, path).unwrap_or_else(|| path.to_string()));
            rest = &rest[end..];
        } else {
            break;
        }
    }
    out.push_str(rest);
    out
}

fn inline_replica_assets(dir: &std::path::Path, html: &str) -> String {
    let mut s = html.to_string();
    for delim in ["src=\"", "src='", "href=\"", "href='"] {
        s = replace_quoted(&s, delim, dir);
    }
    replace_css_urls(&s, dir)
}

/// Resolve a compare_images side from a file path or base64 string.
fn load_image_arg(
    side: &str,
    path: Option<String>,
    b64: Option<String>,
) -> Result<Vec<u8>, String> {
    if let Some(path) = path {
        std::fs::read(&path).map_err(|e| format!("reading {side}_path {path}: {e}"))
    } else if let Some(b64) = b64 {
        base64::engine::general_purpose::STANDARD
            .decode(b64.as_bytes())
            .map_err(|e| format!("{side}_png_b64 is not valid base64: {e}"))
    } else {
        Err(format!("provide {side}_path or {side}_png_b64"))
    }
}

/// Turn an arbitrary label (aria-label / data-qa / font family) into a
/// filesystem- and URL-safe slug for asset filenames.
fn slugify(s: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for ch in s.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if !out.is_empty() && !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out.chars().take(48).collect()
}

#[cfg(target_os = "macos")]
fn ax_trusted() -> bool {
    vibe_extract_core::ax_macos::check_permission(false)
}
#[cfg(not(target_os = "macos"))]
fn ax_trusted() -> bool {
    false
}

#[cfg(target_os = "macos")]
fn ax_request() -> bool {
    let trusted = vibe_extract_core::ax_macos::check_permission(true);
    vibe_extract_core::ax_macos::open_accessibility_settings();
    trusted
}
#[cfg(not(target_os = "macos"))]
fn ax_request() -> bool {
    false
}

// =============================================================================
// Server lifecycle (managed Tauri state + start/stop)
// =============================================================================

/// Managed state holding the running server's cancellation handle + URL.
#[derive(Default)]
pub struct McpServerState {
    inner: Mutex<Option<Running>>,
}

struct Running {
    token: CancellationToken,
    port: u16,
    url: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct McpStatus {
    pub running: bool,
    pub port: Option<u16>,
    pub url: Option<String>,
}

impl McpServerState {
    pub fn snapshot(&self) -> McpStatus {
        match &*self.inner.lock().unwrap() {
            Some(r) => McpStatus {
                running: true,
                port: Some(r.port),
                url: Some(r.url.clone()),
            },
            None => McpStatus {
                running: false,
                port: None,
                url: None,
            },
        }
    }
}

/// Bind 127.0.0.1 on the first free port from 8765 upward (default 8765).
fn pick_free_mcp_port() -> u16 {
    use std::net::TcpListener;
    for p in 8765u16..=8785 {
        if TcpListener::bind(("127.0.0.1", p)).is_ok() {
            return p;
        }
    }
    8765
}

/// Start the embedded MCP server (no-op if already running).
pub async fn start(app: AppHandle) -> Result<McpStatus, String> {
    if app.state::<McpServerState>().snapshot().running {
        return Ok(app.state::<McpServerState>().snapshot());
    }

    let port = pick_free_mcp_port();
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|e| format!("could not bind 127.0.0.1:{port}: {e}"))?;

    let token = CancellationToken::new();
    let url = format!("http://127.0.0.1:{port}/mcp");

    let config = StreamableHttpServerConfig::default()
        .with_cancellation_token(token.clone())
        .with_allowed_hosts([
            "localhost".to_string(),
            "127.0.0.1".to_string(),
            "::1".to_string(),
            format!("127.0.0.1:{port}"),
            format!("localhost:{port}"),
            format!("[::1]:{port}"),
        ]);

    let out_dir = app.state::<crate::OutputDir>().0.clone();
    let app_for_mcp = app.clone();
    let service = StreamableHttpService::new(
        move || Ok(VibeExtractMcp::new(out_dir.clone()).with_app(app_for_mcp.clone())),
        Arc::new(LocalSessionManager::default()),
        config,
    );
    let router = axum::Router::new().nest_service("/mcp", service);

    let serve_token = token.clone();
    tauri::async_runtime::spawn(async move {
        let server = axum::serve(listener, router)
            .with_graceful_shutdown(async move { serve_token.cancelled().await });
        if let Err(e) = server.await {
            log::error!("MCP server exited with error: {e}");
        }
    });

    *app.state::<McpServerState>().inner.lock().unwrap() = Some(Running {
        token,
        port,
        url: url.clone(),
    });
    log::info!("MCP server listening on {url}");
    Ok(app.state::<McpServerState>().snapshot())
}

/// Stop the embedded MCP server (cancels the token; no-op if not running).
pub fn stop(app: &AppHandle) -> McpStatus {
    if let Some(r) = app.state::<McpServerState>().inner.lock().unwrap().take() {
        r.token.cancel();
        log::info!("MCP server stopped (was on port {})", r.port);
    }
    McpStatus {
        running: false,
        port: None,
        url: None,
    }
}

// =============================================================================
// Tauri commands (UI -> server control)
// =============================================================================

#[tauri::command]
pub async fn mcp_status(app: AppHandle) -> McpStatus {
    app.state::<McpServerState>().snapshot()
}

#[tauri::command]
pub async fn mcp_toggle(app: AppHandle) -> Result<McpStatus, String> {
    if app.state::<McpServerState>().snapshot().running {
        Ok(stop(&app))
    } else {
        start(app).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rmcp::handler::server::wrapper::Parameters;

    /// A valid 16×16 RGBA PNG, base64-encoded (generated so `image` accepts it).
    fn tiny_png_b64() -> String {
        use image::{ImageBuffer, Rgba};
        let img: ImageBuffer<Rgba<u8>, Vec<u8>> =
            ImageBuffer::from_fn(16, 16, |x, y| Rgba([(x * 16) as u8, (y * 16) as u8, 128, 255]));
        let mut bytes = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Png)
            .unwrap();
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    fn svc() -> VibeExtractMcp {
        VibeExtractMcp::new(std::env::temp_dir())
    }

    #[test]
    fn tool_router_exposes_the_full_surface() {
        let names: Vec<String> = svc()
            .tool_router
            .list_all()
            .into_iter()
            .map(|t| t.name.to_string())
            .collect();
        for expected in [
            "check_ax_permission",
            "get_selection",
            "request_ax_permission",
            "frontmost_app",
            "list_windows",
            "ax_tree",
            "ax_node_at_point",
            "ax_subtree_at_point",
            "screenshot_region",
            "screenshot_window",
            "sample_color",
            "color_palette",
            "relaunch_with_debug_port",
            "extract_component",
            "extract_assets",
            "compare_images",
            "show_replica",
        ] {
            assert!(names.contains(&expected.to_string()), "missing tool {expected}: {names:?}");
        }
        assert!(names.len() >= 15, "expected >=15 tools, got {}: {names:?}", names.len());
    }

    #[tokio::test]
    async fn compare_images_runs_end_to_end_via_the_tool() {
        let b64 = tiny_png_b64();
        let result = svc()
            .compare_images(Parameters(CompareImagesParam {
                a_path: None,
                a_png_b64: Some(b64.clone()),
                b_path: None,
                b_png_b64: Some(b64),
                threshold: None,
            }))
            .await
            .expect("compare_images tool errored");
        assert_ne!(result.is_error, Some(true), "tool returned is_error=true");
        // Summary text + diff heatmap image.
        assert_eq!(result.content.len(), 2, "expected text + image content");
    }

    #[tokio::test]
    async fn ax_tools_degrade_gracefully_without_a_target() {
        // On macOS without a valid pid these return a CallToolResult error
        // (not a transport-level Err); on non-macOS they report not-implemented.
        let result = svc()
            .list_windows(Parameters(ListWindowsParam { pid: Some(-1) }))
            .await
            .expect("list_windows should not hard-error");
        assert_ne!(result.is_error, Some(true));
    }

    /// Spin the REAL rmcp Streamable-HTTP service on an ephemeral port and do a
    /// live MCP `initialize` handshake over a raw socket — proving the
    /// axum + rmcp transport actually serves. Stateless+json so the response
    /// closes cleanly (no SSE hang).
    #[tokio::test]
    async fn serves_a_live_mcp_initialize_handshake() {
        use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
        use rmcp::transport::streamable_http_server::{
            StreamableHttpServerConfig, StreamableHttpService,
        };
        use std::io::{Read, Write};
        use std::sync::Arc;
        use tokio_util::sync::CancellationToken;

        let token = CancellationToken::new();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();

        let mut config = StreamableHttpServerConfig::default().with_cancellation_token(token.clone());
        config.stateful_mode = false; // plain request/response
        config.json_response = true; // application/json, not SSE — connection closes

        let out = std::env::temp_dir();
        let service = StreamableHttpService::new(
            move || Ok(VibeExtractMcp::new(out.clone())),
            Arc::new(LocalSessionManager::default()),
            config,
        );
        let router = axum::Router::new().nest_service("/mcp", service);
        let serve_token = token.clone();
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(async move { serve_token.cancelled().await })
                .await;
        });

        let body = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}"#;
        let req = format!(
            "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        let resp = tokio::task::spawn_blocking(move || {
            let mut s = std::net::TcpStream::connect(addr).unwrap();
            s.write_all(req.as_bytes()).unwrap();
            let mut buf = String::new();
            let _ = s.read_to_string(&mut buf);
            buf
        })
        .await
        .unwrap();

        token.cancel();
        let _ = server.await;

        assert!(
            resp.contains("HTTP/1.1 2"),
            "expected a 2xx status from /mcp, got:\n{resp}"
        );
        assert!(
            resp.contains("\"result\"") && resp.contains("echo"),
            "expected an MCP initialize result naming the server, got:\n{resp}"
        );
    }
}
