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
    // Picked-element summary — what the user actually clicked. Without this,
    // the user can't tell whether the AX hit-test grabbed what they intended,
    // or whether Apple's API snapped to a stale container.
    let picked_role = match &picked.subrole {
        Some(sub) if !sub.is_empty() => format!("{}:{}", picked.role, sub),
        _ => picked.role.clone(),
    };
    let picked_name = if picked.name.is_empty() {
        String::new()
    } else {
        format!(" \"{}\"", picked.name.replace('"', "\\\""))
    };
    s.push_str(&format!(
        "- Picked: {}{}\n",
        picked_role, picked_name
    ));
    s.push_str(&format!(
        "- Capture target: {:.0} × {:.0} pt @ ({:.0}, {:.0})\n",
        picked.bounds.w, picked.bounds.h, picked.bounds.x, picked.bounds.y
    ));
    let node_count = crate::ax_macos::count_nodes(root);
    let bounds_area = picked.bounds.w * picked.bounds.h;
    s.push_str(&format!("- AX nodes captured: {}\n", node_count));
    s.push('\n');

    // Shallow-tree warning. Triggered when the captured region is big but
    // AX gave us almost nothing — typical for Electron apps without their
    // debug port open. The note points the user at the (already-shipped)
    // relaunch dialog that converts the next ⌘⇧E into a pixel-perfect CDP
    // capture.
    if node_count < 5 && bounds_area > 5_000.0 {
        s.push_str("## Note — shallow AX tree\n");
        s.push_str("This capture region is large but its accessibility tree is nearly empty —\n");
        s.push_str("typical for Electron apps (Slack, WhatsApp, Discord, VS Code, …) that\n");
        s.push_str("weren't launched with --remote-debugging-port. The structure below is\n");
        s.push_str("everything macOS exposed; the actual UI content isn't reachable via AX.\n");
        s.push_str("\n");
        s.push_str("For pixel-perfect HTML + CSS, accept the relaunch dialog that appears\n");
        s.push_str("when you press ⌘⇧E (or set this app to 'Always' in Settings → Electron Apps).\n");
        s.push('\n');
    }

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
    let mut dom = String::new();
    render_dom(root, root_bounds, &mut dom, 0);

    format!(
        r#"<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>VibeExtract — Native Capture</title>
  <style>
    html, body {{ margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; background: #fff; color: #111; }}
    .ve-toolbar {{ position: fixed; top: 0; left: 0; right: 0; padding: 8px 12px; background: rgba(10,20,56,0.96); color: #f0f9ff; font-size: 12px; z-index: 1000; display: flex; gap: 12px; align-items: center; border-bottom: 1px solid rgba(56,189,248,0.3); }}
    .ve-toolbar label {{ display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }}
    .ve-toolbar kbd {{ background: rgba(255,255,255,0.1); padding: 1px 6px; border-radius: 3px; font-family: ui-monospace, Menlo, monospace; font-size: 11px; }}
    .ve-stage {{ margin-top: 44px; padding: 24px; }}
    .ve-canvas {{ position: relative; width: {rw:.0}px; height: {rh:.0}px; background: #fafafa; box-shadow: 0 2px 12px rgba(0,0,0,0.12); border-radius: 6px; overflow: hidden; }}
    /* Screenshot is the BACKGROUND of the canvas, shown at full opacity by
       default so the user sees exactly what they captured — images, icons,
       text, colours. The AX-derived overlay is opt-in (toggle below). */
    .ve-canvas .ve-bg {{ position: absolute; inset: 0; width: 100%; height: 100%; opacity: 1; transition: opacity 200ms; pointer-events: none; z-index: 0; }}

    /* Real-DOM children — each AX element rendered as a semantic HTML tag,
       absolutely positioned at the captured bounds. Hidden by default; tick
       "Show AX structure overlay" in the toolbar to inspect them on top of
       the screenshot. */
    .ve-el {{ position: absolute; box-sizing: border-box; z-index: 1; opacity: 0.85; }}
    body:not(.show-ax) .ve-el {{ display: none; }}
    .ve-button {{
      display: inline-flex; align-items: center; justify-content: center;
      border: 1px solid rgba(0,0,0,0.12); border-radius: 6px; cursor: pointer;
      font: inherit;
      box-shadow: 0 1px 2px rgba(0,0,0,0.05);
    }}
    .ve-text {{ display: flex; align-items: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }}
    .ve-input {{ border: 1px solid rgba(0,0,0,0.15); border-radius: 4px; padding: 2px 6px; font: inherit; box-sizing: border-box; }}
    .ve-link {{ color: #2563eb; text-decoration: underline; cursor: pointer; }}
    .ve-image {{ background: rgba(0,0,0,0.05); border-radius: 4px; }}
    .ve-group {{ /* container — no default border/bg, just a positional shell */ }}
  </style>
</head>
<body>
  <div class="ve-toolbar">
    <strong>VibeExtract — Native Capture</strong>
    <span style="opacity: 0.55;">root: {rw:.0} × {rh:.0} pt</span>
    <label style="margin-left:auto;"><input type="checkbox" id="toggle-ax"> Show AX structure overlay</label>
  </div>
  <div class="ve-stage">
    <div class="ve-canvas">
      <img class="ve-bg" src="data:image/png;base64,{screenshot_b64}">
      {dom}
    </div>
  </div>
  <script>
    document.getElementById('toggle-ax').addEventListener('change', e => {{
      document.body.classList.toggle('show-ax', e.target.checked);
    }});
  </script>
</body>
</html>
"#
    )
}

/// Render an AX node tree into real HTML elements. Each node becomes a tag
/// that matches its semantic role — button, span, input, a, img, div — with
/// absolute positioning + sampled colors as inline styles. The OUTPUT is real
/// DOM the user can paste into their own page and restyle.
#[cfg(target_os = "macos")]
fn render_dom(node: &Node, root_bounds: ScreenRect, out: &mut String, depth: u32) {
    if let Some(b) = node.bounds {
        if b.w < 1.0 || b.h < 1.0 {
            // Zero-sized — recurse children only.
            for kid in &node.children {
                render_dom(kid, root_bounds, out, depth);
            }
            return;
        }
        let lx = b.x - root_bounds.x;
        let ly = b.y - root_bounds.y;
        let (tag, class) = role_to_html(&node.role);
        let bg_style = match node.bg {
            Some((r, g, bl)) => format!(" background-color: rgb({}, {}, {});", r, g, bl),
            None => String::new(),
        };
        // Text-ish defaults — best-effort guess at font color based on bg luminance.
        let color_style = match node.bg {
            Some((r, g, bl)) => {
                let lum = 0.299 * r as f64 + 0.587 * g as f64 + 0.114 * bl as f64;
                if lum < 128.0 { " color: #fff;".to_string() } else { " color: #111;".to_string() }
            }
            None => String::new(),
        };
        let font_size = guess_font_size(&node.role, b.h);
        let font_style = if !font_size.is_empty() {
            format!(" font-size: {font_size};")
        } else {
            String::new()
        };

        let inner_text = if !node.name.is_empty() {
            html_escape(&node.name)
        } else if let Some(v) = &node.value {
            html_escape(v)
        } else {
            String::new()
        };

        let pad = "  ".repeat(depth as usize + 3);
        let style = format!(
            "left:{lx:.0}px; top:{ly:.0}px; width:{w:.0}px; height:{h:.0}px;{bg}{color}{font}",
            lx = lx, ly = ly, w = b.w, h = b.h,
            bg = bg_style, color = color_style, font = font_style
        );

        // For containers, recurse into children INSIDE the parent tag.
        // For leaves (button/text/input/link/image), no recursion needed.
        let is_container = matches!(node.role.as_str(),
            "AXGroup" | "AXScrollArea" | "AXSplitGroup" | "AXTabGroup"
            | "AXToolbar" | "AXOutline" | "AXList" | "AXTable" | "AXRow"
            | "AXColumn" | "AXMenuBar" | "AXMenu" | "AXWindow" | "AXSheet"
            | "AXLayoutArea" | "AXLayoutItem"
        );

        if is_container && !node.children.is_empty() {
            out.push_str(&format!(
                "{pad}<{tag} class=\"ve-el {class}\" data-role=\"{role}\" style=\"{style}\">\n",
                pad = pad, tag = tag, class = class,
                role = html_escape(&node.role), style = style
            ));
            // Children — recursive emit. NOTE: child positions are still
            // RELATIVE TO THE ROOT (not the parent), because AX bounds are
            // screen-absolute. To keep this simple and self-consistent we
            // continue positioning every descendant relative to the root.
            // (More accurate would be nested positioning, but bounds-from-
            //  screen-coords keeps math straightforward.)
            for kid in &node.children {
                render_dom(kid, root_bounds, out, depth + 1);
            }
            out.push_str(&format!("{pad}</{tag}>\n", pad = pad, tag = tag));
        } else {
            // Leaf or empty container — single tag with text content inline.
            if tag == "img" {
                out.push_str(&format!(
                    "{pad}<img class=\"ve-el ve-image\" data-role=\"{role}\" alt=\"{alt}\" style=\"{style}\">\n",
                    pad = pad, role = html_escape(&node.role),
                    alt = inner_text, style = style
                ));
            } else if tag == "input" {
                out.push_str(&format!(
                    "{pad}<input class=\"ve-el {class}\" data-role=\"{role}\" value=\"{val}\" style=\"{style}\">\n",
                    pad = pad, class = class, role = html_escape(&node.role),
                    val = inner_text, style = style
                ));
            } else {
                out.push_str(&format!(
                    "{pad}<{tag} class=\"ve-el {class}\" data-role=\"{role}\" style=\"{style}\">{text}</{tag}>\n",
                    pad = pad, tag = tag, class = class,
                    role = html_escape(&node.role), style = style,
                    text = inner_text
                ));
            }
        }
    } else {
        for kid in &node.children {
            render_dom(kid, root_bounds, out, depth);
        }
    }
}

/// Map AX role → HTML tag + CSS class. Returns ("tag", "class").
#[cfg(target_os = "macos")]
fn role_to_html(role: &str) -> (&'static str, &'static str) {
    match role {
        "AXButton" | "AXPopUpButton" | "AXMenuButton" | "AXRadioButton"
        | "AXCheckBox" | "AXDisclosureTriangle" | "AXIncrementor" | "AXDecrementor" => ("button", "ve-button"),

        "AXStaticText" | "AXHeading" => ("span", "ve-text"),

        "AXTextField" | "AXTextArea" | "AXSearchField" | "AXComboBox" => ("input", "ve-input"),

        "AXLink" => ("a", "ve-link"),

        "AXImage" | "AXIcon" => ("img", "ve-image"),

        "AXGroup" | "AXScrollArea" | "AXSplitGroup" | "AXTabGroup"
        | "AXToolbar" | "AXOutline" | "AXList" | "AXTable" | "AXRow"
        | "AXColumn" | "AXMenuBar" | "AXMenu" | "AXWindow" | "AXSheet"
        | "AXLayoutArea" | "AXLayoutItem" | "AXMenuItem" | "AXCell"
        | "AXWebArea" => ("div", "ve-group"),

        _ => ("div", "ve-group"),
    }
}

/// Heuristic font-size guess based on element height + role.
#[cfg(target_os = "macos")]
fn guess_font_size(role: &str, height: f64) -> String {
    match role {
        "AXStaticText" | "AXHeading" => {
            // Text height = font size + ~30% line-height padding. Reverse it.
            let est = (height / 1.3).round().max(10.0);
            format!("{:.0}px", est)
        }
        "AXButton" | "AXLink" => {
            // Buttons usually have 8-12px vertical padding.
            let est = ((height - 16.0) / 1.3).max(11.0);
            format!("{:.0}px", est)
        }
        _ => String::new(),
    }
}

#[cfg(target_os = "macos")]
#[allow(dead_code)]
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

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use crate::ax_macos::Node;
    use crate::capture::ScreenRect;

    fn make_node(role: &str, children: Vec<Node>) -> Node {
        Node {
            role: role.to_string(),
            subrole: None,
            name: String::new(),
            identifier: None,
            value: None,
            role_description: None,
            bounds: Some(ScreenRect { x: 0.0, y: 0.0, w: 100.0, h: 100.0 }),
            bg: None,
            children,
        }
    }

    fn make_picked(role: &str, w: f64, h: f64) -> PickedElement {
        PickedElement {
            role: role.to_string(),
            subrole: None,
            name: String::new(),
            identifier: None,
            bounds: ScreenRect { x: 0.0, y: 0.0, w, h },
            pid: 1234,
            app_path: None,
            window_title: None,
            window_bounds: None,
        }
    }

    #[test]
    fn toon_header_includes_picked_summary_and_capture_target() {
        let root = make_node("AXButton", vec![]);
        let picked = make_picked("AXButton", 48.0, 48.0);
        let out = emit_toon(&root, &[], &picked, None);
        assert!(out.contains("- Picked: AXButton"), "missing Picked line: {}", out);
        assert!(
            out.contains("- Capture target: 48 × 48 pt @ (0, 0)"),
            "missing Capture target line: {}", out
        );
        assert!(
            out.contains("- AX nodes captured: 1"),
            "missing AX nodes captured line: {}", out
        );
    }

    #[test]
    fn toon_emits_shallow_tree_note_when_big_bounds_few_nodes() {
        // Mimics WhatsApp's left-rail capture: huge region but ~1 AX node.
        let root = make_node("AXGroup", vec![]);
        let picked = make_picked("AXGroup", 67.0, 658.0); // area = 44,086 (> 5,000)
        let out = emit_toon(&root, &[], &picked, None);
        assert!(
            out.contains("## Note — shallow AX tree"),
            "shallow-tree note missing: {}", out
        );
        assert!(
            out.contains("--remote-debugging-port"),
            "shallow-tree note should mention the relaunch fix: {}", out
        );
    }

    #[test]
    fn toon_skips_shallow_note_for_rich_trees() {
        // Many children → no warning, even if bounds are big.
        let children: Vec<Node> = (0..10).map(|_| make_node("AXButton", vec![])).collect();
        let root = make_node("AXWindow", children);
        let picked = make_picked("AXWindow", 800.0, 600.0);
        let out = emit_toon(&root, &[], &picked, None);
        assert!(
            !out.contains("## Note — shallow AX tree"),
            "shallow-tree note must NOT appear on rich tree: {}", out
        );
    }

    #[test]
    fn toon_skips_shallow_note_for_tiny_bounds() {
        // 48x48 button — bounds.area = 2,304 (< 5,000). Even if 1 node, no
        // warning because the user is intentionally targeting something small.
        let root = make_node("AXButton", vec![]);
        let picked = make_picked("AXButton", 48.0, 48.0);
        let out = emit_toon(&root, &[], &picked, None);
        assert!(
            !out.contains("## Note — shallow AX tree"),
            "shallow-tree note must NOT appear on small bounds: {}", out
        );
    }

    #[test]
    fn toon_picked_includes_subrole_and_name_quotes() {
        let root = make_node("AXButton", vec![]);
        let mut picked = make_picked("AXButton", 48.0, 48.0);
        picked.subrole = Some("AXToolbarButton".to_string());
        picked.name = "Send".to_string();
        let out = emit_toon(&root, &[], &picked, None);
        assert!(
            out.contains(r#"- Picked: AXButton:AXToolbarButton "Send""#),
            "subrole+name not formatted: {}", out
        );
    }

    // ── emit_html defaults (Change 2: screenshot visible, AX overlay opt-in) ──

    #[test]
    fn html_default_shows_screenshot_at_full_opacity() {
        let root = make_node("AXGroup", vec![]);
        let picked = make_picked("AXGroup", 100.0, 100.0);
        let out = emit_html(&root, "FAKE_B64", picked.bounds);
        // Background image rule must default to opacity: 1
        assert!(
            out.contains(".ve-bg") && out.contains("opacity: 1;"),
            ".ve-bg must default to opacity: 1 (full visible). Got:\n{}", out
        );
        // Must NOT have the old ghost-opacity rule
        assert!(
            !out.contains("opacity: 0.30"),
            "old ghost overlay rule (.ve-bg opacity: 0.30) must be removed. Got:\n{}", out
        );
    }

    #[test]
    fn html_default_hides_ax_overlay() {
        let root = make_node("AXGroup", vec![]);
        let picked = make_picked("AXGroup", 100.0, 100.0);
        let out = emit_html(&root, "FAKE_B64", picked.bounds);
        // AX elements hidden by default — only shown when body has .show-ax
        assert!(
            out.contains("body:not(.show-ax) .ve-el { display: none; }"),
            "AX overlay must be hidden by default. Got:\n{}", out
        );
        // Toggle exists with the new id/label
        assert!(
            out.contains(r#"id="toggle-ax""#) && out.contains("Show AX structure overlay"),
            "Toggle checkbox must be 'Show AX structure overlay' with id toggle-ax. Got:\n{}", out
        );
    }

    #[test]
    fn html_embeds_screenshot_base64() {
        let root = make_node("AXGroup", vec![]);
        let picked = make_picked("AXGroup", 100.0, 100.0);
        let out = emit_html(&root, "MY_SCREENSHOT_B64", picked.bounds);
        assert!(
            out.contains(r#"<img class="ve-bg" src="data:image/png;base64,MY_SCREENSHOT_B64">"#),
            "screenshot PNG must be embedded as base64 data URI. Got:\n{}", out
        );
    }

    #[test]
    fn html_old_toggle_ref_no_longer_exists() {
        let root = make_node("AXGroup", vec![]);
        let picked = make_picked("AXGroup", 100.0, 100.0);
        let out = emit_html(&root, "B64", picked.bounds);
        assert!(
            !out.contains("toggle-ref") && !out.contains("show-ref"),
            "old toggle-ref / show-ref class names must be gone (renamed to toggle-ax / show-ax). Got:\n{}", out
        );
    }
}
