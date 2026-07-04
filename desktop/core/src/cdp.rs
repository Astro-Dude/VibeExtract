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
/// All ports are probed CONCURRENTLY (worst case ~250ms instead of the old
/// sequential 11 × 250ms = 2.75s — the common pre-relaunch Electron case is
/// "no port open", which used to eat the full 2.75s before the relaunch
/// dialog could even appear). Lowest open port wins, deterministically.
pub async fn discover_port() -> Option<u16> {
    let client = reqwest::Client::new(); // one client, shared pool (Arc-backed)
    let probes = (9220u16..=9230).map(|p| {
        let client = client.clone();
        async move {
            client
                .get(format!("http://127.0.0.1:{p}/json/version"))
                .timeout(Duration::from_millis(250))
                .send()
                .await
                .ok()
                .filter(|r| r.status().is_success())
                .map(|_| p)
        }
    });
    futures_util::future::join_all(probes)
        .await
        .into_iter()
        .flatten()
        .min()
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
    // Build a structural Node tree from the live DOM at the click — the web
    // counterpart to the macOS AX walk, so a Chromium/CEF surface yields the
    // SAME `Node` shape `ax_tree` emits instead of "(none)". Best-effort: any
    // failure just leaves ax_tree None and the export (html/toon) still stands.
    // Bounds are viewport-relative CSS px (== points); a consumer that needs
    // screen-space offsets by the web-content origin (see `dom_tree_at`).
    // Depth 20 / 1500 nodes (was 12/600): big Electron components (Slack
    // threads, Notion pages) blew the old budget and silently lost their deep
    // children. The walker now also marks the node where a budget ran out
    // (`truncated`) so an incomplete tree is visible instead of silent.
    let ax_tree = fetch_dom_tree(&mut socket, &mut next_id, viewport_x, viewport_y, 20, 1500)
        .await
        .ok()
        .flatten()
        .map(|d| dom_to_node(d, 0.0, 0.0))
        .and_then(|n| serde_json::to_string_pretty(&n).ok());
    Ok(CaptureResult {
        strategy: "cdp".into(),
        fidelity: "Pixel-perfect (runtime CDP)".into(),
        toon,
        html,
        screenshot_png_b64: None,
        diagnostics: vec![],
        ax_tree,
    })
}

/// One element resolved by [`probe_at`] — its viewport rect (top-left CSS px,
/// which equal macOS points) plus role/tag/label. The caller adds the window
/// origin to get screen-space bounds.
#[derive(Debug, Clone, Deserialize)]
pub struct ProbeHit {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub tag: String,
    #[serde(default)]
    pub label: String,
}

// Self-contained probe expression. Placeholders __X__/__Y__/__WIDEN__ are filled
// by `probe_at` (via `.replace`, so the JS keeps single braces — no `format!`
// escaping). Mirrors contentScript.js `expandToMeaningfulContainer`: from the
// element at the point, expand to the nearest visually-distinct / structural
// container, then walk up `widen` more parents. Returns the rect + role/label,
// or null. No inject, no click, no export — just one `Runtime.evaluate`.
const PROBE_JS: &str = r#"(function(){
  try {
    var x=__X__, y=__Y__, widen=__WIDEN__;
    var el = document.elementFromPoint(x,y);
    if(!el) return null;
    function expand(el){
      var tag=(el.tagName||'').toLowerCase();
      if(['div','section','article','aside','nav','header','footer','main','form','fieldset','ul','ol','table','tbody','thead','tr'].indexOf(tag)>=0) return el;
      if(['input','select','textarea','button','a','span','img','svg','label','i','em','strong','p','h1','h2','h3','h4','h5','h6'].indexOf(tag)<0) return el;
      var sr=el.getBoundingClientRect(); var startArea=sr.width*sr.height; if(!startArea) return el;
      var maxA=window.innerWidth*window.innerHeight*0.4, minG=1.2;
      var cur=el.parentElement, depth=0, best=null;
      while(cur&&cur!==document.body&&cur!==document.documentElement&&depth<8){
        var cr=cur.getBoundingClientRect(); var cA=cr.width*cr.height;
        if(cA>maxA) break;
        if(cA<startArea*minG){cur=cur.parentElement;depth++;continue;}
        var cs=getComputedStyle(cur);
        var distinct=(cs.backgroundColor&&cs.backgroundColor!=='rgba(0, 0, 0, 0)'&&cs.backgroundColor!=='transparent')||parseFloat(cs.borderTopWidth)>0||parseFloat(cs.borderLeftWidth)>0||parseFloat(cs.borderTopLeftRadius)>0||(cs.boxShadow&&cs.boxShadow!=='none')||parseFloat(cs.paddingTop)>=4||parseFloat(cs.paddingLeft)>=4;
        var structural=['form','fieldset','label','li','tr','article','section','header','footer','aside','nav'].indexOf((cur.tagName||'').toLowerCase())>=0;
        if(distinct||structural){return cur;}
        cur=cur.parentElement;depth++;
      }
      return best||el;
    }
    el=expand(el);
    for(var i=0;i<widen&&el.parentElement&&el.parentElement!==document.body&&el.parentElement!==document.documentElement;i++) el=el.parentElement;
    var r=el.getBoundingClientRect();
    var label=(el.getAttribute&&(el.getAttribute('aria-label')||el.getAttribute('data-qa')))||'';
    if(!label) label=(el.textContent||'').trim().slice(0,60);
    return {x:r.left,y:r.top,w:r.width,h:r.height,role:((el.getAttribute&&el.getAttribute('role'))||'')+'',tag:(el.tagName||'').toLowerCase(),label:label};
  } catch(e){ return null; }
})()"#;

/// Live-hover probe: the element at viewport (vx, vy), expanded to a meaningful
/// container plus `widen` extra parent steps. Fast enough to drive the pick-mode
/// highlight (one `Runtime.evaluate` over a short-lived connection, no inject /
/// click / export). 3s hard timeout. `Ok(None)` = nothing under the point.
pub async fn probe_at(
    port: u16,
    target_index: usize,
    vx: f64,
    vy: f64,
    widen: u32,
) -> Result<Option<ProbeHit>> {
    let inner = probe_at_inner(port, target_index, vx, vy, widen);
    match tokio::time::timeout(Duration::from_secs(3), inner).await {
        Ok(r) => r,
        Err(_) => bail!("CDP probe_at timed out (3s)"),
    }
}

async fn probe_at_inner(
    port: u16,
    target_index: usize,
    vx: f64,
    vy: f64,
    widen: u32,
) -> Result<Option<ProbeHit>> {
    let ws_url = discover_target(port, target_index).await?;
    let (mut socket, _) = tokio::time::timeout(Duration::from_secs(2), connect_async(&ws_url))
        .await
        .map_err(|_| anyhow!("CDP WS connect timed out (2s)"))?
        .context("CDP WS connect")?;
    let mut next_id: u64 = 0;
    let mut mk = |method: &str, params: Value| -> CdpCommand {
        next_id += 1;
        CdpCommand { id: next_id, method: method.to_string(), params }
    };
    call(&mut socket, mk("Runtime.enable", json!({}))).await?;
    let expr = PROBE_JS
        .replace("__X__", &format!("{:.2}", vx))
        .replace("__Y__", &format!("{:.2}", vy))
        .replace("__WIDEN__", &widen.to_string());
    let res = eval(
        &mut socket,
        mk(
            "Runtime.evaluate",
            json!({"expression": expr, "returnByValue": true}),
        ),
    )
    .await?;
    let _ = socket.close(None).await;
    let val = res
        .get("result")
        .and_then(|r| r.get("value"))
        .cloned()
        .unwrap_or(Value::Null);
    if val.is_null() {
        return Ok(None);
    }
    let hit: ProbeHit = serde_json::from_value(val).context("parse ProbeHit")?;
    if hit.w < 1.0 || hit.h < 1.0 {
        return Ok(None);
    }
    Ok(Some(hit))
}

// ---------------------------------------------------------------------------
// DOM → Node tree (the web/CEF counterpart to the macOS AX walk)
// ---------------------------------------------------------------------------
//
// When a surface is Chromium content that AX exposes as an opaque/empty
// `AXWebArea` (Electron, or WPS's CEF document view), the real structure IS the
// DOM. This walks the DOM subtree at a point into the SAME `ax_macos::Node`
// shape the AX walk produces — so component extraction / `ax_tree` works on web
// surfaces too, with clean per-element roles, names and bounds.
//
// CONSTRAINT: requires the target to have been launched with
// `--remote-debugging-port`. Apps we don't control (e.g. WPS, whose CEF host
// exposes no such flag) can't be given one without a relaunch they don't
// support — so this serves our own `relaunch_with_debug_port` Electron path and
// documents the route for genuine CEF apps rather than enabling WPS directly.

/// One DOM element as returned by `DOM_TREE_JS` (viewport-relative CSS px).
#[derive(Debug, Clone, Deserialize)]
struct DomNode {
    #[serde(default)]
    role: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    ident: String,
    #[serde(default)]
    tag: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    #[serde(default)]
    truncated: bool,
    #[serde(default)]
    children: Vec<DomNode>,
}

// Self-contained DOM walker. Placeholders __X__/__Y__/__MAXD__/__BUDGET__ are
// filled by `fetch_dom_tree` (single braces — no `format!`). From the element
// at the point it expands to the meaningful container (mirrors PROBE_JS), then
// walks the subtree to depth __MAXD__ / __BUDGET__ visible nodes, skipping
// zero-area and non-rendered elements. Returns a nested {role,name,ident,tag,
// x,y,w,h,children} tree, or null.
const DOM_TREE_JS: &str = r#"(function(){
  try{
    var x=__X__, y=__Y__, MAXD=__MAXD__, BUDGET=__BUDGET__, count=0;
    var start=document.elementFromPoint(x,y);
    if(!start) return null;
    function expand(el){
      var tag=(el.tagName||'').toLowerCase();
      if(['div','section','article','aside','nav','header','footer','main','form','fieldset','ul','ol','table','tbody','thead','tr'].indexOf(tag)>=0) return el;
      if(['input','select','textarea','button','a','span','img','svg','label','i','em','strong','p','h1','h2','h3','h4','h5','h6'].indexOf(tag)<0) return el;
      var sr=el.getBoundingClientRect(); var startArea=sr.width*sr.height; if(!startArea) return el;
      var maxA=window.innerWidth*window.innerHeight*0.4, minG=1.2;
      var cur=el.parentElement, depth=0;
      while(cur&&cur!==document.body&&cur!==document.documentElement&&depth<8){
        var cr=cur.getBoundingClientRect(); var cA=cr.width*cr.height;
        if(cA>maxA) break;
        if(cA<startArea*minG){cur=cur.parentElement;depth++;continue;}
        var cs=getComputedStyle(cur);
        var distinct=(cs.backgroundColor&&cs.backgroundColor!=='rgba(0, 0, 0, 0)'&&cs.backgroundColor!=='transparent')||parseFloat(cs.borderTopWidth)>0||parseFloat(cs.borderTopLeftRadius)>0||(cs.boxShadow&&cs.boxShadow!=='none')||parseFloat(cs.paddingTop)>=4;
        var structural=['form','fieldset','label','li','tr','article','section','header','footer','aside','nav'].indexOf((cur.tagName||'').toLowerCase())>=0;
        if(distinct||structural) return cur;
        cur=cur.parentElement;depth++;
      }
      return el;
    }
    function role(el){
      var r=el.getAttribute&&el.getAttribute('role'); if(r) return r;
      var t=(el.tagName||'').toLowerCase();
      var m={button:'AXButton',a:'AXLink',input:'AXTextField',textarea:'AXTextArea',img:'AXImage',svg:'AXImage',select:'AXPopUpButton',nav:'AXGroup',main:'AXGroup',header:'AXGroup',footer:'AXGroup',ul:'AXList',ol:'AXList',li:'AXListItem',table:'AXTable',tr:'AXRow',td:'AXCell',th:'AXCell',h1:'AXHeading',h2:'AXHeading',h3:'AXHeading',h4:'AXHeading',h5:'AXHeading',h6:'AXHeading',p:'AXStaticText',label:'AXStaticText',span:'AXStaticText'};
      return m[t]||'AXGroup';
    }
    function nm(el){
      var n=(el.getAttribute&&(el.getAttribute('aria-label')||el.getAttribute('alt')||el.getAttribute('title')))||'';
      if(!n){var t='';for(var c=el.firstChild;c;c=c.nextSibling){if(c.nodeType===3)t+=c.nodeValue;}n=t.trim().slice(0,80);}
      return n;
    }
    function ident(el){return ((el.id||(el.getAttribute&&el.getAttribute('data-qa'))||'')+'').slice(0,60);}
    function walk(el,depth){
      if(count>=BUDGET) return null;
      var r=el.getBoundingClientRect();
      if(r.width<1||r.height<1) return null;
      var cs=getComputedStyle(el);
      if(cs.visibility==='hidden'||cs.display==='none') return null;
      count++;
      var node={role:role(el),name:nm(el),ident:ident(el),tag:(el.tagName||'').toLowerCase(),x:r.left,y:r.top,w:r.width,h:r.height,children:[]};
      if(depth<MAXD){
        for(var c=el.firstElementChild;c;c=c.nextElementSibling){
          var t=(c.tagName||'').toLowerCase();
          if(t==='script'||t==='style'||t==='meta'||t==='link'||t==='noscript') continue;
          var ch=walk(c,depth+1);
          if(ch) node.children.push(ch);
          if(count>=BUDGET){node.truncated=true;break;}
        }
      }else if(el.firstElementChild){node.truncated=true;}
      return node;
    }
    return walk(expand(start),0);
  }catch(e){ return null; }
})()"#;

/// Convert a DOM subtree to an `ax_macos::Node`, offsetting each viewport rect
/// by `(ox, oy)` (the web-content origin, in points) to get screen-space
/// bounds; pass `(0,0)` to keep viewport-relative. `child_source: "CDP-DOM"`
/// marks every node's provenance (this came from the DOM, not AX).
fn dom_to_node(d: DomNode, ox: f64, oy: f64) -> crate::ax_macos::Node {
    crate::ax_macos::Node {
        role: if d.role.is_empty() { "AXGroup".into() } else { d.role },
        subrole: None,
        name: d.name,
        identifier: (!d.ident.is_empty()).then_some(d.ident),
        value: None,
        role_description: (!d.tag.is_empty()).then_some(d.tag),
        bounds: Some(crate::capture::ScreenRect {
            x: d.x + ox,
            y: d.y + oy,
            w: d.w,
            h: d.h,
        }),
        bg: None,
        state: Vec::new(),
        min_value: None,
        max_value: None,
        truncated: d.truncated,
        child_source: Some("CDP-DOM".into()),
        children: d
            .children
            .into_iter()
            .map(|c| dom_to_node(c, ox, oy))
            .collect(),
    }
}

/// Run `DOM_TREE_JS` over an already-open socket and parse the result. Shared
/// by `extract_at_viewport` (reuses its session) and `dom_tree_at` (own
/// connection). `Ok(None)` = nothing meaningful under the point.
async fn fetch_dom_tree<S>(
    socket: &mut S,
    next_id: &mut u64,
    vx: f64,
    vy: f64,
    max_depth: u32,
    max_nodes: u32,
) -> Result<Option<DomNode>>
where
    S: SinkExt<Message, Error = tokio_tungstenite::tungstenite::Error>
        + StreamExt<Item = std::result::Result<Message, tokio_tungstenite::tungstenite::Error>>
        + Unpin,
{
    *next_id += 1;
    let expr = DOM_TREE_JS
        .replace("__X__", &format!("{:.2}", vx))
        .replace("__Y__", &format!("{:.2}", vy))
        .replace("__MAXD__", &max_depth.to_string())
        .replace("__BUDGET__", &max_nodes.to_string());
    let res = eval(
        socket,
        CdpCommand {
            id: *next_id,
            method: "Runtime.evaluate".to_string(),
            params: json!({"expression": expr, "returnByValue": true}),
        },
    )
    .await?;
    let val = res
        .get("result")
        .and_then(|r| r.get("value"))
        .cloned()
        .unwrap_or(Value::Null);
    if val.is_null() {
        return Ok(None);
    }
    Ok(Some(serde_json::from_value(val).context("parse DomNode tree")?))
}

/// Build a structural [`crate::ax_macos::Node`] tree from the live DOM at
/// viewport `(vx, vy)`, expanded to the meaningful container — a standalone
/// (own-connection) entry point mirroring [`probe_at`]. `origin` is the
/// screen-space top-left (points) of the web viewport, added to each element's
/// rect so bounds are screen-space. `Ok(None)` = nothing under the point. 5s
/// hard timeout.
pub async fn dom_tree_at(
    port: u16,
    target_index: usize,
    vx: f64,
    vy: f64,
    origin: (f64, f64),
    max_depth: u32,
    max_nodes: u32,
) -> Result<Option<crate::ax_macos::Node>> {
    let inner = async {
        let ws_url = discover_target(port, target_index).await?;
        let (mut socket, _) = tokio::time::timeout(Duration::from_secs(3), connect_async(&ws_url))
            .await
            .map_err(|_| anyhow!("CDP WS connect timed out (3s)"))?
            .context("CDP WS connect")?;
        let mut next_id: u64 = 1;
        call(
            &mut socket,
            CdpCommand {
                id: next_id,
                method: "Runtime.enable".to_string(),
                params: json!({}),
            },
        )
        .await?;
        let dom = fetch_dom_tree(&mut socket, &mut next_id, vx, vy, max_depth, max_nodes).await?;
        let _ = socket.close(None).await;
        Ok::<_, anyhow::Error>(dom.map(|d| dom_to_node(d, origin.0, origin.1)))
    };
    match tokio::time::timeout(Duration::from_secs(5), inner).await {
        Ok(r) => r,
        Err(_) => bail!("CDP dom_tree_at timed out (5s)"),
    }
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
