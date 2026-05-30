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
pub async fn extract_at_viewport(
    port: u16,
    target_index: usize,
    viewport_x: f64,
    viewport_y: f64,
    content_script: &str,
) -> Result<CaptureResult> {
    let ws_url = discover_target(port, target_index).await?;
    let (mut socket, _) = connect_async(&ws_url).await.context("CDP WS connect")?;
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

/// Translate window-local coords (in points) to viewport-local CSS pixels by
/// asking the page for `outerHeight - innerHeight`. Caller has already
/// determined `window_local_y` etc. from AX bounds.
pub async fn translate_via_metrics(
    port: u16,
    window_local_x: f64,
    window_local_y: f64,
) -> Result<(f64, f64)> {
    let ws_url = discover_target(port, 0).await?;
    let (mut socket, _) = connect_async(&ws_url).await.context("CDP WS connect")?;
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
