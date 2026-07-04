// Phase 0 spike: prove that injecting the existing VibeExtract `contentScript.js`
// into a running Electron app via the Chrome DevTools Protocol yields the same
// pixel-perfect TOON/HTML output as the browser extension does in a regular page.
//
// Usage:
//   1. Start any Electron app with remote debugging enabled, e.g.
//        code --remote-debugging-port=9222
//   2. From this folder: `cargo run -- --auto-pick "div.activitybar"`
//
// The spike reads `../../contentScript.js` (the extension's content script,
// UNMODIFIED) and injects it into the target page via `Runtime.evaluate`. The
// contentScript already supports a `window.postMessage` IPC path
// (see contentScript.js around line 2826), so we can drive it without
// `chrome.runtime.*` ever being needed.

use anyhow::{anyhow, bail, Context, Result};
use clap::Parser;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::Duration;
use tokio_tungstenite::{connect_async, tungstenite::Message};

#[derive(Parser, Debug)]
#[command(about = "VibeExtract CDP spike — inject contentScript.js into a running Electron app and dump the TOON/HTML it produces")]
struct Args {
    /// Chrome DevTools Protocol port on localhost (must match the --remote-debugging-port the target app was launched with).
    #[arg(long, default_value_t = 9222)]
    port: u16,

    /// CSS selector for the element to pick. If omitted, the spike arms pick mode and waits 10s for the user to click in the target window.
    #[arg(long)]
    auto_pick: Option<String>,

    /// Path to contentScript.js. Defaults to ../../contentScript.js (the sibling browser extension file, unmodified).
    #[arg(long, default_value = "../../contentScript.js")]
    content_script: PathBuf,

    /// Index of the page target to attach to (0 = first). Useful if the app has multiple windows.
    #[arg(long, default_value_t = 0)]
    target_index: usize,
}

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

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();

    let content_script = std::fs::read_to_string(&args.content_script)
        .with_context(|| format!("reading contentScript.js from {}", args.content_script.display()))?;
    eprintln!("[spike] loaded contentScript.js — {} bytes", content_script.len());

    let ws_url = discover_target(args.port, args.target_index).await?;
    eprintln!("[spike] attaching to {}", ws_url);

    let (mut socket, _) = connect_async(&ws_url).await.context("WebSocket connect to CDP target")?;
    let mut next_id: u64 = 0;
    let mut send_cmd = |method: &str, params: Value| -> CdpCommand {
        next_id += 1;
        CdpCommand { id: next_id, method: method.to_string(), params }
    };

    // 1. Enable the domains we need.
    call(&mut socket, send_cmd("Runtime.enable", json!({}))).await?;
    call(&mut socket, send_cmd("Page.enable", json!({}))).await?;

    // 2. Inject contentScript.js verbatim. We wrap it in an IIFE so its top-level
    //    `let`/`const` don't clash on re-injection, and in a try/catch so the
    //    extension-only branches (chrome.storage, chrome.runtime.sendMessage)
    //    that are already guarded in the file produce no uncaught errors.
    let inject_expr = format!(
        "(function(){{try{{{}\n}}catch(e){{console.warn('[VibeExtract spike] injection error:',e);}}}})();",
        content_script
    );
    eval(&mut socket, send_cmd("Runtime.evaluate", json!({
        "expression": inject_expr,
        "awaitPromise": false,
        "returnByValue": true,
    }))).await?;
    eprintln!("[spike] contentScript.js injected");

    // 3. Arm pick mode.
    eval(&mut socket, send_cmd("Runtime.evaluate", json!({
        "expression": "window.postMessage({fromParent:true, msgId:1, type:'START_PICK_MODE'}, '*'); 'armed'",
        "returnByValue": true,
    }))).await?;
    eprintln!("[spike] pick mode armed");

    // 4. Pick an element — either by selector (automated) or by waiting for the user to click manually.
    match &args.auto_pick {
        Some(selector) => {
            eprintln!("[spike] auto-picking element matching {:?}", selector);
            // Locate the element and dispatch a real mousedown via CDP Input domain
            // so the contentScript's `mousedown` capture-phase listener at
            // contentScript.js:386 fires with a proper composedPath.
            let bounds_js = format!(
                r#"(()=>{{const el=document.querySelector({sel});if(!el){{return null;}}const r=el.getBoundingClientRect();return {{x:r.left+r.width/2, y:r.top+r.height/2, w:r.width, h:r.height}};}})()"#,
                sel = serde_json::to_string(selector)?
            );
            let bounds = eval(&mut socket, send_cmd("Runtime.evaluate", json!({
                "expression": bounds_js,
                "returnByValue": true,
            }))).await?;
            let bounds = bounds
                .get("result")
                .and_then(|r| r.get("value"))
                .cloned()
                .ok_or_else(|| anyhow!("selector {:?} did not match any element in the target page", selector))?;
            if bounds.is_null() {
                bail!("selector {:?} did not match any element in the target page", selector);
            }
            let x = bounds["x"].as_f64().context("bounds.x not a number")?;
            let y = bounds["y"].as_f64().context("bounds.y not a number")?;
            eprintln!("[spike] target bounds center: ({:.1}, {:.1})", x, y);

            call(&mut socket, send_cmd("Input.dispatchMouseEvent", json!({
                "type": "mousePressed",
                "x": x,
                "y": y,
                "button": "left",
                "buttons": 1,
                "clickCount": 1,
            }))).await?;
            call(&mut socket, send_cmd("Input.dispatchMouseEvent", json!({
                "type": "mouseReleased",
                "x": x,
                "y": y,
                "button": "left",
                "buttons": 0,
                "clickCount": 1,
            }))).await?;
            // Give the contentScript a moment to handle the click + build the clone.
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        None => {
            eprintln!("[spike] no --auto-pick selector given. Pick an element in the target app within the next 10 seconds.");
            tokio::time::sleep(Duration::from_secs(10)).await;
        }
    }

    // 5. Trigger export. The contentScript's postMessage handler at
    //    contentScript.js:2826 builds the export synchronously when there's a
    //    selection and posts the result back via `event.source.postMessage`.
    //    We wrap the round-trip in a Promise so CDP's `awaitPromise:true` gives
    //    us the structured result directly.
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
            // Safety net: if no response in 5s, resolve to a sentinel so the
            // spike doesn't hang forever.
            setTimeout(() => {
                window.removeEventListener('message', handler);
                resolve({error: 'EXPORT_SELECTION timed out — was anything actually selected?'});
            }, 5000);
        })
    "#;
    let result_obj = eval(&mut socket, send_cmd("Runtime.evaluate", json!({
        "expression": export_js,
        "awaitPromise": true,
        "returnByValue": true,
    }))).await?;

    let export_payload = result_obj
        .get("result")
        .and_then(|r| r.get("value"))
        .cloned()
        .ok_or_else(|| anyhow!("EXPORT_SELECTION returned no value: {:?}", result_obj))?;

    if let Some(err) = export_payload.get("error").and_then(|v| v.as_str()) {
        bail!("export failed: {}", err);
    }

    let toon = export_payload.get("toon").and_then(|v| v.as_str()).unwrap_or("(missing)");
    let html = export_payload.get("html").and_then(|v| v.as_str()).unwrap_or("(missing)");
    let fonts = export_payload.get("fontFaces").map(|v| v.as_array().map(|a| a.len()).unwrap_or(0)).unwrap_or(0);

    eprintln!("[spike] success — toon: {} bytes, html: {} bytes, fonts: {}", toon.len(), html.len(), fonts);
    eprintln!("[spike] ---- TOON ----");
    println!("{}", toon);
    eprintln!("[spike] ---- HTML preview (first 800 chars) ----");
    let preview: String = html.chars().take(800).collect();
    eprintln!("{}", preview);

    // Write outputs to disk so they can be diffed against the browser extension's output.
    std::fs::write("spike-output.toon", toon).context("writing spike-output.toon")?;
    std::fs::write("spike-output.html", html).context("writing spike-output.html")?;
    eprintln!("[spike] wrote spike-output.toon and spike-output.html");

    Ok(())
}

/// Hit `/json` on the DevTools HTTP endpoint and pick a page target.
async fn discover_target(port: u16, index: usize) -> Result<String> {
    let url = format!("http://127.0.0.1:{port}/json");
    let targets: Vec<PageTarget> = reqwest::get(&url)
        .await
        .with_context(|| format!("HTTP GET {url} — is the target Electron app running with --remote-debugging-port={port}?"))?
        .json()
        .await
        .context("parsing /json response as Vec<PageTarget>")?;

    let pages: Vec<&PageTarget> = targets
        .iter()
        .filter(|t| t.target_type == "page" && t.ws_url.is_some())
        .collect();

    if pages.is_empty() {
        bail!("no 'page' targets found on port {port}. Found {} targets total: {:?}",
            targets.len(),
            targets.iter().map(|t| (&t.target_type, &t.title)).collect::<Vec<_>>());
    }

    let chosen = pages.get(index).copied().ok_or_else(|| anyhow!("target_index {index} out of range; found {} page targets", pages.len()))?;
    eprintln!("[spike] target: {} ({})", chosen.title, chosen.url);
    Ok(chosen.ws_url.clone().unwrap())
}

/// Send a CDP command and await its response, ignoring unrelated event messages.
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
        let msg = socket.next().await.ok_or_else(|| anyhow!("CDP stream closed"))?
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
            _ => {
                // Unrelated event/notification — ignore.
                continue;
            }
        }
    }
}

/// Wrapper around `call` for `Runtime.evaluate` that also surfaces JS-side exceptions.
async fn eval<S>(socket: &mut S, cmd: CdpCommand) -> Result<Value>
where
    S: SinkExt<Message, Error = tokio_tungstenite::tungstenite::Error>
        + StreamExt<Item = std::result::Result<Message, tokio_tungstenite::tungstenite::Error>>
        + Unpin,
{
    let result = call(socket, cmd).await?;
    if let Some(exc) = result.get("exceptionDetails") {
        bail!("Runtime.evaluate threw: {}", exc);
    }
    Ok(result)
}
