//! TOON + HTML emission for native paths (rank 4-6 strategies).

#[cfg(target_os = "macos")]
use crate::ax_macos::Node;
use crate::capture::{PickedElement, ScreenRect};

#[cfg(target_os = "macos")]
pub fn emit_toon(
    root: &Node,
    palette: &[(u8, u8, u8)],
    picked: &PickedElement,
    bundle: Option<&crate::bundle_macos::BundleSummary>,
) -> String {
    let mut s = String::new();
    s.push_str("# VibeExtract — Native Desktop Capture\n\n");

    s.push_str("## Source\n");
    if let Some(p) = &picked.app_path {
        s.push_str(&format!("- App: {}\n", p));
    }
    if let Some(t) = &picked.window_title {
        s.push_str(&format!("- Window: \"{}\"\n", t));
    }
    if let Some(b) = bundle {
        if let Some(id) = &b.bundle_id {
            s.push_str(&format!("- Bundle-ID: {}\n", id));
        }
        if let Some(name) = &b.display_name {
            s.push_str(&format!("- App name: {}\n", name));
        }
        if !b.nibs.is_empty() {
            s.push_str(&format!("- NIBs recovered: {}\n", b.nibs.iter().map(|n| n.name.clone()).collect::<Vec<_>>().join(", ")));
        }
    }
    s.push('\n');

    if !palette.is_empty() {
        s.push_str("## Palette\n");
        for (i, (r, g, b)) in palette.iter().enumerate() {
            s.push_str(&format!(".c{}: #{:02x}{:02x}{:02x}\n", i + 1, r, g, b));
        }
        s.push('\n');
    }

    s.push_str("## Structure\n");
    emit_toon_node(root, 0, &mut s);
    s
}

#[cfg(target_os = "macos")]
fn emit_toon_node(node: &Node, indent: u32, out: &mut String) {
    let pad = "  ".repeat(indent as usize);
    let role = match &node.subrole {
        Some(sub) => format!("{}:{}", node.role, sub),
        None => node.role.clone(),
    };
    let bounds_str = match node.bounds {
        Some(b) => format!(" pos=({:.0},{:.0}) size=({:.0}x{:.0})", b.x, b.y, b.w, b.h),
        None => String::new(),
    };
    let bg_str = match node.bg {
        Some((r, g, b)) => format!(" bg=#{:02x}{:02x}{:02x}", r, g, b),
        None => String::new(),
    };
    let id_str = node
        .identifier
        .as_ref()
        .map(|i| format!(" #{}", i))
        .unwrap_or_default();
    let role_desc = node
        .role_description
        .as_ref()
        .map(|d| format!(" ({})", d))
        .unwrap_or_default();
    let name_str = if node.name.is_empty() {
        String::new()
    } else {
        let truncated: String = node.name.chars().take(80).collect();
        format!(" \"{}\"", truncated.replace('"', "\\\""))
    };
    let value_str = node
        .value
        .as_ref()
        .filter(|v| !v.is_empty())
        .map(|v| {
            let truncated: String = v.chars().take(80).collect();
            format!(" value=\"{}\"", truncated.replace('"', "\\\""))
        })
        .unwrap_or_default();

    if node.children.is_empty() {
        out.push_str(&format!(
            "{}{}{}{}{}{}{}{}\n",
            pad, role, name_str, value_str, bounds_str, bg_str, id_str, role_desc
        ));
    } else {
        out.push_str(&format!(
            "{}{}{}{}{}{}{}{} {{\n",
            pad, role, name_str, value_str, bounds_str, bg_str, id_str, role_desc
        ));
        for kid in &node.children {
            emit_toon_node(kid, indent + 1, out);
        }
        out.push_str(&format!("{}}}\n", pad));
    }
}

#[cfg(target_os = "macos")]
pub fn emit_html(root: &Node, screenshot_b64: &str, root_bounds: ScreenRect) -> String {
    let (rw, rh) = (root_bounds.w, root_bounds.h);
    let mut boxes = String::new();
    render_html_boxes(root, root_bounds, &mut boxes);

    format!(
        r#"<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>VibeExtract — Native Capture</title>
  <style>
    html, body {{ margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; background: #f7f7f7; }}
    .toolbar {{ position: fixed; top: 0; left: 0; right: 0; padding: 8px 12px; background: #2d2d2d; color: #fff; font-size: 13px; z-index: 100; display: flex; gap: 12px; align-items: center; }}
    .toolbar label {{ display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }}
    .stage {{ margin-top: 48px; padding: 24px; display: flex; gap: 24px; align-items: flex-start; flex-wrap: wrap; }}
    .panel {{ flex: 0 0 auto; }}
    .panel h2 {{ margin: 0 0 8px 0; font-size: 13px; font-weight: 600; color: #444; text-transform: uppercase; letter-spacing: 0.5px; }}
    .replica {{ position: relative; width: {rw:.0}px; height: {rh:.0}px; background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,0.15); }}
    .replica img.bg {{ position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; }}
    .ax-box {{ position: absolute; box-sizing: border-box; border: 1px solid rgba(0, 122, 255, 0.55); background: rgba(0, 122, 255, 0.04); font-size: 10px; color: rgba(0, 60, 130, 0.85); padding: 1px 3px; overflow: hidden; }}
    .ax-box[data-role="AXStaticText"], .ax-box[data-role="AXTextField"] {{ border-color: rgba(180, 60, 0, 0.5); color: rgba(180, 60, 0, 0.95); background: rgba(255, 200, 100, 0.06); }}
    .ax-box[data-role="AXButton"] {{ border-color: rgba(0, 130, 50, 0.55); background: rgba(0, 200, 100, 0.06); color: rgba(0, 80, 30, 0.85); }}
    body.hide-overlay .ax-box {{ display: none; }}
    body.hide-bg .replica img.bg {{ display: none; }}
  </style>
</head>
<body class="hide-overlay">
  <div class="toolbar">
    <strong>VibeExtract — Native Desktop Capture</strong>
    <label><input type="checkbox" id="toggle-overlay"> Show AX overlay</label>
    <label><input type="checkbox" id="toggle-bg" checked> Show screenshot</label>
    <span style="opacity: 0.6; margin-left: auto;">root: {rw:.0} × {rh:.0} pt</span>
  </div>
  <div class="stage">
    <div class="panel">
      <h2>Live composite</h2>
      <div class="replica">
        <img class="bg" src="data:image/png;base64,{screenshot_b64}">
        {boxes}
      </div>
    </div>
  </div>
  <script>
    document.getElementById('toggle-overlay').addEventListener('change', e => {{
      document.body.classList.toggle('hide-overlay', !e.target.checked);
    }});
    document.getElementById('toggle-bg').addEventListener('change', e => {{
      document.body.classList.toggle('hide-bg', !e.target.checked);
    }});
  </script>
</body>
</html>
"#
    )
}

#[cfg(target_os = "macos")]
fn render_html_boxes(node: &Node, root_bounds: ScreenRect, out: &mut String) {
    if let Some(b) = node.bounds {
        let lx = b.x - root_bounds.x;
        let ly = b.y - root_bounds.y;
        if b.w >= 1.0 && b.h >= 1.0 {
            let label = if !node.name.is_empty() {
                format!("{} \"{}\"", node.role, html_escape(&node.name))
            } else {
                node.role.clone()
            };
            let bg_style = match node.bg {
                Some((r, g, bl)) => format!(" background-color: rgba({}, {}, {}, 0.10);", r, g, bl),
                None => String::new(),
            };
            let short = label_short(node);
            out.push_str(&format!(
                "<div class=\"ax-box\" data-role=\"{}\" style=\"left:{:.0}px; top:{:.0}px; width:{:.0}px; height:{:.0}px;{}\" title=\"{}\">{}</div>\n",
                html_escape(&node.role),
                lx, ly, b.w, b.h,
                bg_style,
                html_escape(&label),
                html_escape(&short),
            ));
        }
    }
    for kid in &node.children {
        render_html_boxes(kid, root_bounds, out);
    }
}

#[cfg(target_os = "macos")]
fn label_short(node: &Node) -> String {
    if !node.name.is_empty() {
        node.name.chars().take(40).collect()
    } else {
        node.role.clone()
    }
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
