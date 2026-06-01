//! CDP injection of the unmodified browser extension's `contentScript.js`.
//! This is the rank-2 strategy: works for any Electron app that was launched
//! with `--remote-debugging-port=<PORT>`.

use crate::output::CaptureResult;
use anyhow::{anyhow, bail, Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
use tokio_tungstenite::{connect_async, tungstenite::Message};

#[derive(Debug, Deserialize)]
struct PageTarget {
    #[serde(rename = "type")]
    target_type: String,
    title: String,
    url: String,
    #[serde(rename = "webSocketDebuggerUrl")]
    ws_url: Option<String>,
}

#[derive(Debug, Serialize)]
struct CdpCommand {
    id: u64,
    method: String,
    params: Value,
}

/// Discover a CDP debug port on localhost in 9220..9230 by probing /json/version.
pub async fn discover_port() -> Option<u16> {
    for p in 9220u16..=9230 {
        if let Ok(resp) = reqwest::Client::new()
            .get(format!("http://127.0.0.1:{p}/json/version"))
            .timeout(Duration::from_millis(250))
            .send()
            .await
        {
            if resp.status().is_success() {
                return Some(p);
            }
        }
    }
    None
}

async fn discover_target(port: u16, index: usize) -> Result<String> {
    let url = format!("http://127.0.0.1:{port}/json");
    let targets: Vec<PageTarget> = reqwest::get(&url)
        .await
        .with_context(|| format!("HTTP GET {url}"))?
        .json()
        .await
        .context("parsing /json")?;
    let pages: Vec<&PageTarget> = targets
        .iter()
        .filter(|t| t.target_type == "page" && t.ws_url.is_some())
        .collect();
    if pages.is_empty() {
        bail!("no page targets on port {port}");
    }
    let chosen = pages
        .get(index)
        .copied()
        .ok_or_else(|| anyhow!("target_index {index} out of range"))?;
    log::info!("CDP target: {} ({})", chosen.title, chosen.url);
    Ok(chosen.ws_url.clone().unwrap())
}

async fn call<S>(socket: &mut S, cmd: CdpCommand) -> Result<Value>
where
    S: SinkExt<Message, Error = tokio_tungstenite::tungstenite::Error>
        + StreamExt<Item = std::result::Result<Message, tokio_tungstenite::tungstenite::Error>>
        + Unpin,
{
    let cmd_id = cmd.id;
    let cmd_method = cmd.method.clone();
    let payload = serde_json::to_string(&cmd)?;
    socket.send(Message::Text(payload)).await.context("CDP send")?;
    loop {
        let msg = socket
            .next()
            .await
            .ok_or_else(|| anyhow!("CDP stream closed"))?
            .context("CDP recv")?;
        let text = match msg {
            Message::Text(t) => t,
            Message::Binary(_) | Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => continue,
            Message::Close(_) => bail!("CDP socket closed"),
        };
        let val: Value = serde_json::from_str(&text).context("CDP JSON parse")?;
        match val.get("id").and_then(|i| i.as_u64()) {
            Some(id) if id == cmd_id => {
                if let Some(err) = val.get("error") {
                    bail!("CDP {} returned error: {}", cmd_method, err);
                }
                return Ok(val.get("result").cloned().unwrap_or(Value::Null));
            }
            _ => continue,
        }
    }
}

async fn eval<S>(socket: &mut S, cmd: CdpCommand) -> Result<Value>
where
    S: SinkExt<Message, Error = tokio_tungstenite::tungstenite::Error>
        + StreamExt<Item = std::result::Result<Message, tokio_tungstenite::tungstenite::Error>>
        + Unpin,
{
    let r = call(socket, cmd).await?;
    if let Some(exc) = r.get("exceptionDetails") {
        bail!("Runtime.evaluate threw: {}", exc);
    }
    Ok(r)
}

/// Inject the unmodified `contentScript.js` into the page at `viewport_x,
/// viewport_y`, dispatch a synthesized click there to trigger the
/// contentScript's pick handler, then collect the export.
///
/// `content_script` is the raw bytes of the extension's `contentScript.js`
/// (read by the caller — keeps this function free of filesystem coupling).
///
/// Wrapped in a 15-second hard timeout. If anything stalls (Slack's CDP
/// agent occasionally hangs Runtime.evaluate when injecting into Shadow-DOM
/// pages), we fail fast instead of blocking the dispatcher forever.
pub async fn extract_at_viewport(
    port: u16,
    target_index: usize,
    viewport_x: f64,
    viewport_y: f64,
    content_script: &str,
) -> Result<CaptureResult> {
    let inner = extract_at_viewport_inner(port, target_index, viewport_x, viewport_y, content_script);
    match tokio::time::timeout(Duration::from_secs(15), inner).await {
        Ok(r) => r,
        Err(_) => bail!("CDP extract_at_viewport timed out after 15s — Slack's CDP agent is unresponsive. Falling through to AX path."),
    }
}

async fn extract_at_viewport_inner(
    port: u16,
    target_index: usize,
    viewport_x: f64,
    viewport_y: f64,
    content_script: &str,
) -> Result<CaptureResult> {
    let ws_url = discover_target(port, target_index).await?;
    // tokio_tungstenite's connect_async has no default timeout. Wrap it.
    let (mut socket, _) = tokio::time::timeout(Duration::from_secs(3), connect_async(&ws_url))
        .await
        .map_err(|_| anyhow!("CDP WS connect timed out (3s)"))?
        .context("CDP WS connect")?;
    let mut next_id: u64 = 0;
    let mut mk = |method: &str, params: Value| -> CdpCommand {
        next_id += 1;
        CdpCommand {
            id: next_id,
            method: method.to_string(),
            params,
        }
    };

    call(&mut socket, mk("Runtime.enable", json!({}))).await?;
    call(&mut socket, mk("Page.enable", json!({}))).await?;

    let inject = format!(
        "(function(){{try{{{}\n}}catch(e){{console.warn('[VibeExtract cdp] inject:',e);}}}})();",
        content_script
    );
    eval(
        &mut socket,
        mk(
            "Runtime.evaluate",
            json!({"expression": inject, "awaitPromise": false, "returnByValue": true}),
        ),
    )
    .await?;

    eval(
        &mut socket,
        mk(
            "Runtime.evaluate",
            json!({
                "expression": "window.postMessage({fromParent:true, msgId:1, type:'START_PICK_MODE'}, '*'); 'armed'",
                "returnByValue": true,
            }),
        ),
    )
    .await?;

    call(
        &mut socket,
        mk(
            "Input.dispatchMouseEvent",
            json!({"type":"mousePressed","x":viewport_x,"y":viewport_y,"button":"left","buttons":1,"clickCount":1}),
        ),
    )
    .await?;
    call(
        &mut socket,
        mk(
            "Input.dispatchMouseEvent",
            json!({"type":"mouseReleased","x":viewport_x,"y":viewport_y,"button":"left","buttons":0,"clickCount":1}),
        ),
    )
    .await?;
    tokio::time::sleep(Duration::from_millis(200)).await;

    let export_js = r#"
        new Promise((resolve) => {
            const msgId = Math.random().toString(36).slice(2);
            const handler = (event) => {
                if (event.data && event.data.msgId === msgId && 'result' in event.data) {
                    window.removeEventListener('message', handler);
                    resolve(event.data.result);
                }
            };
            window.addEventListener('message', handler);
            window.postMessage({fromParent:true, msgId, type:'EXPORT_SELECTION'}, '*');
            setTimeout(() => {
                window.removeEventListener('message', handler);
                resolve({error:'EXPORT_SELECTION timed out'});
            }, 5000);
        })
    "#;
    let result = eval(
        &mut socket,
        mk(
            "Runtime.evaluate",
            json!({"expression": export_js, "awaitPromise": true, "returnByValue": true}),
        ),
    )
    .await?;
    let payload = result
        .get("result")
        .and_then(|r| r.get("value"))
        .cloned()
        .ok_or_else(|| anyhow!("no result"))?;
    if let Some(err) = payload.get("error").and_then(|v| v.as_str()) {
        bail!("export failed: {}", err);
    }
    let toon = payload
        .get("toon")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let html = payload
        .get("html")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if toon.is_empty() && html.is_empty() {
        bail!("export returned empty");
    }
    Ok(CaptureResult {
        strategy: "cdp".into(),
        fidelity: "Pixel-perfect (runtime CDP)".into(),
        toon,
        html,
        screenshot_png_b64: None,
        diagnostics: vec![],
    })
}

/// Harvest pixel-perfect assets (fonts, icon glyphs, images) from a running
/// Electron renderer via CDP. `harvester_js` must be a single expression that
/// evaluates to a Promise resolving to a manifest object (see `assetHarvester.js`).
/// After the in-page harvest, any image entry that lacks `base64` (a CORS-opaque
/// CDN asset the page's `fetch` couldn't read) but carries a `rect` is filled in
/// here via `Page.captureScreenshot` with that clip — rendered pixels, no auth.
/// Wrapped in a 45s hard timeout (fetching several fonts/images is slower than
/// the single-element `extract_at_viewport`).
pub async fn harvest_assets(
    port: u16,
    target_index: usize,
    harvester_js: &str,
) -> Result<Value> {
    let inner = harvest_assets_inner(port, target_index, harvester_js);
    match tokio::time::timeout(Duration::from_secs(45), inner).await {
        Ok(r) => r,
        Err(_) => bail!("CDP harvest_assets timed out after 45s"),
    }
}

async fn harvest_assets_inner(
    port: u16,
    target_index: usize,
    harvester_js: &str,
) -> Result<Value> {
    let ws_url = discover_target(port, target_index).await?;
    let (mut socket, _) = tokio::time::timeout(Duration::from_secs(3), connect_async(&ws_url))
        .await
        .map_err(|_| anyhow!("CDP WS connect timed out (3s)"))?
        .context("CDP WS connect")?;
    let mut next_id: u64 = 0;
    let mut mk = |method: &str, params: Value| -> CdpCommand {
        next_id += 1;
        CdpCommand {
            id: next_id,
            method: method.to_string(),
            params,
        }
    };

    call(&mut socket, mk("Runtime.enable", json!({}))).await?;
    call(&mut socket, mk("Page.enable", json!({}))).await?;

    let res = eval(
        &mut socket,
        mk(
            "Runtime.evaluate",
            json!({"expression": harvester_js, "awaitPromise": true, "returnByValue": true}),
        ),
    )
    .await?;
    let mut manifest = res
        .get("result")
        .and_then(|r| r.get("value"))
        .cloned()
        .ok_or_else(|| anyhow!("asset harvester returned no value"))?;

    let dpr = manifest.get("dpr").and_then(|v| v.as_f64()).unwrap_or(1.0).max(1.0);

    // Fill in CORS-opaque images (no base64 from the page fetch) by capturing
    // each element's clip — pixel-perfect rendered bytes, immune to auth/CORS.
    if let Some(images) = manifest.get_mut("images").and_then(|v| v.as_array_mut()) {
        for img in images.iter_mut() {
            if img.get("base64").and_then(|v| v.as_str()).is_some() {
                continue;
            }
            let rect = match img.get("rect").cloned() {
                Some(r) => r,
                None => continue,
            };
            let x = rect.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let y = rect.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let w = rect.get("w").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let h = rect.get("h").and_then(|v| v.as_f64()).unwrap_or(0.0);
            if w < 1.0 || h < 1.0 {
                continue;
            }
            let shot = call(
                &mut socket,
                mk(
                    "Page.captureScreenshot",
                    json!({
                        "format": "png",
                        "captureBeyondViewport": true,
                        "fromSurface": true,
                        "clip": {"x": x, "y": y, "width": w, "height": h, "scale": dpr},
                    }),
                ),
            )
            .await;
            match shot {
                Ok(v) => {
                    if let (Some(data), Some(obj)) =
                        (v.get("data").and_then(|d| d.as_str()), img.as_object_mut())
                    {
                        obj.insert("base64".into(), Value::String(data.to_string()));
                        obj.insert("mime".into(), Value::String("image/png".into()));
                        obj.insert("via".into(), Value::String("captureScreenshot".into()));
                    }
                }
                Err(e) => log::warn!("captureScreenshot clip failed: {e}"),
            }
        }
    }

    Ok(manifest)
}

/// Translate window-local coords (in points) to viewport-local CSS pixels by
/// asking the page for `outerHeight - innerHeight`. Caller has already
/// determined `window_local_y` etc. from AX bounds. 5-second total timeout
/// so it can't hang the dispatcher.
pub async fn translate_via_metrics(
    port: u16,
    window_local_x: f64,
    window_local_y: f64,
) -> Result<(f64, f64)> {
    let inner = translate_via_metrics_inner(port, window_local_x, window_local_y);
    tokio::time::timeout(Duration::from_secs(5), inner)
        .await
        .map_err(|_| anyhow!("CDP translate_via_metrics timed out (5s)"))?
}

async fn translate_via_metrics_inner(
    port: u16,
    window_local_x: f64,
    window_local_y: f64,
) -> Result<(f64, f64)> {
    let ws_url = discover_target(port, 0).await?;
    let (mut socket, _) = tokio::time::timeout(Duration::from_secs(3), connect_async(&ws_url))
        .await
        .map_err(|_| anyhow!("CDP WS connect timed out (3s)"))?
        .context("CDP WS connect")?;
    let mut next_id: u64 = 0;
    let mut mk = |method: &str, params: Value| -> CdpCommand {
        next_id += 1;
        CdpCommand {
            id: next_id,
            method: method.to_string(),
            params,
        }
    };
    call(&mut socket, mk("Runtime.enable", json!({}))).await?;
    let metrics = eval(
        &mut socket,
        mk(
            "Runtime.evaluate",
            json!({
                "expression":"({outerH: window.outerHeight, innerH: window.innerHeight})",
                "returnByValue": true,
            }),
        ),
    )
    .await?;
    let m = metrics
        .get("result")
        .and_then(|r| r.get("value"))
        .cloned()
        .unwrap_or(Value::Null);
    let outer_h = m.get("outerH").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let inner_h = m.get("innerH").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let chrome_y = (outer_h - inner_h).max(0.0);
    Ok((window_local_x, window_local_y - chrome_y))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Live integration test (ignored by default): drives the real
    /// `harvest_assets` CDP path against a running Electron app on 9220–9230
    /// using the repo's `assetHarvester.js`. Verifies fonts + inline SVG icons
    /// + images come back, and that at least one image carries bytes (fetched
    /// in-page or filled via the `Page.captureScreenshot` clip fallback).
    /// Run with: `cargo test -p vibe-extract-core -- --ignored harvest_assets`.
    #[tokio::test]
    #[ignore]
    async fn harvest_assets_against_live_electron() {
        let port = discover_port().await.expect("no Chromium debug port on 9220-9230");
        let js = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../assetHarvester.js"))
            .expect("read assetHarvester.js");
        let m = harvest_assets(port, 0, &js).await.expect("harvest_assets failed");
        let n = |k: &str| m.get(k).and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
        eprintln!("harvested fonts={} svgIcons={} images={}", n("fonts"), n("svgIcons"), n("images"));
        assert!(n("fonts") > 0, "expected at least one @font-face");
        assert!(n("svgIcons") > 0 || n("icons") > 0, "expected at least one icon");
        let with_bytes = m
            .get("images")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter(|i| i.get("base64").and_then(|v| v.as_str()).is_some()).count())
            .unwrap_or(0);
        assert!(with_bytes > 0, "expected at least one image with bytes");
    }
}
