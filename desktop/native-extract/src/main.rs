// Phase 2-full: native macOS extractor.
//
// Unlike the CDP path (which only works for Chromium/Electron targets), this
// binary works on ANY macOS app — Finder, Calculator, System Settings, native
// Slack/Notes/Mail, anything that exposes an accessibility tree.
//
// The pipeline:
//   1. Hit-test at the cursor (or --cursor-screen override) → root AX element.
//   2. Walk its subtree depth-first, collecting role, name, bounds, value,
//      identifier, role-description, and detected children.
//   3. screencapture -R the root element's bounding box to a temp PNG.
//   4. Sample pixel colors at the center + 4 corners of each child to estimate
//      backgroundColor / foreground luminance.
//   5. Emit `.toon` and `.html` in the same shape VibeExtract's browser
//      extension produces, with the screenshot embedded as a base64 backdrop
//      so the HTML is visually verifiable against the source.
//
// Run:
//   native-extract --cursor-screen 400,300
//   native-extract                          # uses live cursor position
//
// First run will prompt for Accessibility + Screen Recording permission.

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine as _;
use clap::Parser;
use core_foundation::array::{CFArray, CFArrayRef};
use core_foundation::base::{CFGetTypeID, CFRelease, CFTypeRef, TCFType, ToVoid};
use core_foundation::boolean::{kCFBooleanTrue, CFBoolean};
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::{CFString, CFStringRef};
use core_graphics::display::CGPoint;
use std::ffi::c_void;
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(about = "Native macOS UI extractor — pick an element in any desktop app via AX, dump structure + sampled colors + screenshot.")]
struct Args {
    /// Override the cursor screen position (AX coords, top-left origin). Format: "X,Y".
    /// If omitted, the live cursor position is used.
    #[arg(long)]
    cursor_screen: Option<String>,

    /// Max recursion depth when walking AX children. Native apps can have very
    /// deep trees; the default keeps output manageable while still covering
    /// component-sized selections.
    #[arg(long, default_value_t = 12)]
    max_depth: u32,

    /// Where to write outputs. Defaults to the current working directory.
    #[arg(long, default_value = ".")]
    out_dir: PathBuf,
}

// =============================================================================
// AX FFI
// =============================================================================

#[allow(non_camel_case_types)]
type AXUIElementRef = *const c_void;
#[allow(non_camel_case_types)]
type AXValueRef = *const c_void;
#[allow(non_camel_case_types)]
type AXError = i32;

const K_AX_ERROR_SUCCESS: AXError = 0;
const K_AX_VALUE_TYPE_CG_POINT: u32 = 1;
const K_AX_VALUE_TYPE_CG_SIZE: u32 = 2;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;
    fn AXUIElementCreateSystemWide() -> AXUIElementRef;
    fn AXUIElementCopyElementAtPosition(
        application: AXUIElementRef,
        x: f32,
        y: f32,
        element: *mut AXUIElementRef,
    ) -> AXError;
    fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: *mut CFTypeRef,
    ) -> AXError;
    fn AXValueGetType(value: AXValueRef) -> u32;
    fn AXValueGetValue(value: AXValueRef, the_type: u32, value_ptr: *mut c_void) -> bool;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventCreate(source: *const c_void) -> *const c_void;
    fn CGEventGetLocation(event: *const c_void) -> CGPoint;
}

struct AxElement(AXUIElementRef);
impl Drop for AxElement {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CFRelease(self.0 as *const _) };
        }
    }
}

impl AxElement {
    fn str_attr(&self, key: &str) -> Option<String> {
        let key_cf = CFString::new(key);
        let mut value: CFTypeRef = std::ptr::null();
        let err = unsafe {
            AXUIElementCopyAttributeValue(self.0, key_cf.as_concrete_TypeRef(), &mut value)
        };
        if err != K_AX_ERROR_SUCCESS || value.is_null() {
            return None;
        }
        let type_id = unsafe { CFGetTypeID(value) };
        if type_id == CFString::type_id() {
            let s = unsafe { CFString::wrap_under_create_rule(value as CFStringRef) };
            Some(s.to_string())
        } else {
            unsafe { CFRelease(value) };
            None
        }
    }

    fn point_attr(&self, key: &str) -> Option<CGPoint> {
        let key_cf = CFString::new(key);
        let mut value: CFTypeRef = std::ptr::null();
        let err = unsafe {
            AXUIElementCopyAttributeValue(self.0, key_cf.as_concrete_TypeRef(), &mut value)
        };
        if err != K_AX_ERROR_SUCCESS || value.is_null() {
            return None;
        }
        let ty = unsafe { AXValueGetType(value as AXValueRef) };
        if ty != K_AX_VALUE_TYPE_CG_POINT {
            unsafe { CFRelease(value) };
            return None;
        }
        let mut pt = CGPoint { x: 0.0, y: 0.0 };
        let ok = unsafe {
            AXValueGetValue(
                value as AXValueRef,
                K_AX_VALUE_TYPE_CG_POINT,
                &mut pt as *mut CGPoint as *mut c_void,
            )
        };
        unsafe { CFRelease(value) };
        if ok { Some(pt) } else { None }
    }

    fn size_attr(&self, key: &str) -> Option<(f64, f64)> {
        let key_cf = CFString::new(key);
        let mut value: CFTypeRef = std::ptr::null();
        let err = unsafe {
            AXUIElementCopyAttributeValue(self.0, key_cf.as_concrete_TypeRef(), &mut value)
        };
        if err != K_AX_ERROR_SUCCESS || value.is_null() {
            return None;
        }
        let ty = unsafe { AXValueGetType(value as AXValueRef) };
        if ty != K_AX_VALUE_TYPE_CG_SIZE {
            unsafe { CFRelease(value) };
            return None;
        }
        #[repr(C)]
        struct CGSize { width: f64, height: f64 }
        let mut sz = CGSize { width: 0.0, height: 0.0 };
        let ok = unsafe {
            AXValueGetValue(
                value as AXValueRef,
                K_AX_VALUE_TYPE_CG_SIZE,
                &mut sz as *mut CGSize as *mut c_void,
            )
        };
        unsafe { CFRelease(value) };
        if ok { Some((sz.width, sz.height)) } else { None }
    }

    /// Read an AX array attribute (AXChildren etc.) into a Vec of owned wrappers.
    /// Borrowed refs from CFArray must be retained when wrapped — AxElement's
    /// Drop calls CFRelease, so we need balanced retains.
    fn array_attr(&self, key: &str) -> Vec<AxElement> {
        let key_cf = CFString::new(key);
        let mut value: CFTypeRef = std::ptr::null();
        let err = unsafe {
            AXUIElementCopyAttributeValue(self.0, key_cf.as_concrete_TypeRef(), &mut value)
        };
        if err != K_AX_ERROR_SUCCESS || value.is_null() {
            return Vec::new();
        }
        let type_id = unsafe { CFGetTypeID(value) };
        if type_id != unsafe { CFArrayGetTypeID() } {
            unsafe { CFRelease(value) };
            return Vec::new();
        }
        let array = unsafe { CFArray::<*const c_void>::wrap_under_create_rule(value as CFArrayRef) };
        let len = array.len();
        let mut out = Vec::with_capacity(len as usize);
        for i in 0..len {
            let item = array.get(i).map(|r| *r).unwrap_or(std::ptr::null());
            if item.is_null() {
                continue;
            }
            // Retain so the AxElement Drop balances correctly.
            unsafe { CFRetain(item as *const _) };
            out.push(AxElement(item as AXUIElementRef));
        }
        out
    }
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRetain(cf: *const c_void) -> *const c_void;
    fn CFArrayGetTypeID() -> usize;
}

fn current_cursor() -> CGPoint {
    unsafe {
        let event = CGEventCreate(std::ptr::null());
        if event.is_null() {
            return CGPoint { x: -1.0, y: -1.0 };
        }
        let pt = CGEventGetLocation(event);
        CFRelease(event);
        pt
    }
}

fn element_under_cursor(system: AXUIElementRef, pt: CGPoint) -> Option<AxElement> {
    let mut out: AXUIElementRef = std::ptr::null();
    let err = unsafe { AXUIElementCopyElementAtPosition(system, pt.x as f32, pt.y as f32, &mut out) };
    if err != K_AX_ERROR_SUCCESS || out.is_null() {
        None
    } else {
        Some(AxElement(out))
    }
}

fn check_ax_permission() -> bool {
    if unsafe { AXIsProcessTrusted() } {
        return true;
    }
    let key = CFString::from_static_string("AXTrustedCheckOptionPrompt");
    let value = unsafe { CFBoolean::wrap_under_get_rule(kCFBooleanTrue) };
    let dict: CFDictionary<CFString, CFBoolean> = CFDictionary::from_CFType_pairs(&[(key, value)]);
    unsafe { AXIsProcessTrustedWithOptions(dict.to_void()) }
}

// =============================================================================
// Captured tree model
// =============================================================================

#[derive(Debug, Clone)]
struct Node {
    role: String,
    subrole: Option<String>,
    name: String,
    identifier: Option<String>,
    value: Option<String>,
    role_description: Option<String>,
    /// Bounds in screen points: (x, y, w, h). top-left origin (AX coords).
    bounds: Option<(f64, f64, f64, f64)>,
    /// Sampled background color (R,G,B) at the element center, after screenshot.
    bg: Option<(u8, u8, u8)>,
    children: Vec<Node>,
}

fn capture_node(el: &AxElement, depth: u32, max_depth: u32) -> Node {
    let role = el.str_attr("AXRole").unwrap_or_else(|| "AXUnknown".into());
    let subrole = el.str_attr("AXSubrole").filter(|s| !s.is_empty());
    let name = el
        .str_attr("AXTitle")
        .or_else(|| el.str_attr("AXDescription"))
        .or_else(|| el.str_attr("AXLabel"))
        .or_else(|| el.str_attr("AXValue"))
        .unwrap_or_default();
    let identifier = el.str_attr("AXIdentifier").filter(|s| !s.is_empty());
    let value = el.str_attr("AXValue").filter(|s| !s.is_empty() && Some(s) != Some(&name));
    let role_description = el.str_attr("AXRoleDescription").filter(|s| !s.is_empty());

    let bounds = match (el.point_attr("AXPosition"), el.size_attr("AXSize")) {
        (Some(p), Some((w, h))) => Some((p.x, p.y, w, h)),
        _ => None,
    };

    let mut children = Vec::new();
    if depth < max_depth {
        // Prefer AXVisibleChildren (skips offscreen) when present.
        let kids = {
            let visible = el.array_attr("AXVisibleChildren");
            if !visible.is_empty() {
                visible
            } else {
                el.array_attr("AXChildren")
            }
        };
        for kid in &kids {
            children.push(capture_node(kid, depth + 1, max_depth));
        }
    }

    Node {
        role,
        subrole,
        name,
        identifier,
        value,
        role_description,
        bounds,
        bg: None,
        children,
    }
}

// =============================================================================
// Screenshot + pixel sampling
// =============================================================================

/// Capture a screen region to a PNG file at `out_path`, using macOS's
/// `screencapture` CLI. Region is (x, y, w, h) in screen points.
fn screencapture_region(bounds: (f64, f64, f64, f64), out_path: &std::path::Path) -> Result<()> {
    let (x, y, w, h) = bounds;
    if w < 1.0 || h < 1.0 {
        bail!("element has zero-sized bounds: {:?}", bounds);
    }
    let region = format!("{:.0},{:.0},{:.0},{:.0}", x, y, w, h);
    let status = std::process::Command::new("/usr/sbin/screencapture")
        .args(["-x", "-R", &region]) // -x: silent, no shutter sound; -R: region
        .arg(out_path)
        .status()
        .context("invoking /usr/sbin/screencapture")?;
    if !status.success() {
        bail!("screencapture exited with status {:?}", status.code());
    }
    if !out_path.exists() {
        bail!("screencapture didn't produce {}", out_path.display());
    }
    Ok(())
}

fn sample_pixel(
    img: &image::RgbaImage,
    root_bounds: (f64, f64, f64, f64),
    point: (f64, f64),
) -> Option<(u8, u8, u8)> {
    // `img` is the screenshot of `root_bounds`. Translate the absolute screen
    // point into image-local pixel coords, taking the actual image scale into
    // account (screencapture writes at the screen's native pixel scale, not at
    // point resolution — so on a Retina display the PNG is 2× the region size).
    let (rx, ry, rw, rh) = root_bounds;
    let (px, py) = point;
    if rw <= 0.0 || rh <= 0.0 {
        return None;
    }
    let rel_x = (px - rx) / rw; // 0..1
    let rel_y = (py - ry) / rh;
    if !(0.0..=1.0).contains(&rel_x) || !(0.0..=1.0).contains(&rel_y) {
        return None;
    }
    let (img_w, img_h) = (img.width() as f64, img.height() as f64);
    let ix = (rel_x * img_w).clamp(0.0, img_w - 1.0) as u32;
    let iy = (rel_y * img_h).clamp(0.0, img_h - 1.0) as u32;
    let p = img.get_pixel(ix, iy);
    Some((p[0], p[1], p[2]))
}

fn fill_sampled_colors(node: &mut Node, img: &image::RgbaImage, root_bounds: (f64, f64, f64, f64)) {
    if let Some((x, y, w, h)) = node.bounds {
        let cx = x + w / 2.0;
        let cy = y + h / 2.0;
        node.bg = sample_pixel(img, root_bounds, (cx, cy));
    }
    for kid in &mut node.children {
        fill_sampled_colors(kid, img, root_bounds);
    }
}

// =============================================================================
// TOON / HTML emission (VibeExtract-compatible shape)
// =============================================================================

fn emit_toon(root: &Node, sampled_palette: &Vec<(u8, u8, u8)>) -> String {
    let mut s = String::new();
    s.push_str("# VibeExtract — Native macOS Capture\n\n");

    // Palette section, analogous to the styles section in the web TOON.
    if !sampled_palette.is_empty() {
        s.push_str("## Palette\n");
        for (i, (r, g, b)) in sampled_palette.iter().enumerate() {
            s.push_str(&format!(".c{}: #{:02x}{:02x}{:02x}\n", i + 1, r, g, b));
        }
        s.push('\n');
    }

    // Structure section.
    s.push_str("## Structure\n");
    emit_toon_node(root, 0, &mut s);
    s
}

fn emit_toon_node(node: &Node, indent: u32, out: &mut String) {
    let pad = "  ".repeat(indent as usize);
    let role = match &node.subrole {
        Some(sub) => format!("{}:{}", node.role, sub),
        None => node.role.clone(),
    };
    let bounds_str = match node.bounds {
        Some((x, y, w, h)) => format!(" pos=({:.0},{:.0}) size=({:.0}x{:.0})", x, y, w, h),
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

fn emit_html(
    root: &Node,
    screenshot_b64: &str,
    root_bounds: (f64, f64, f64, f64),
) -> String {
    let (rw, rh) = (root_bounds.2, root_bounds.3);
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
<body>
  <div class="toolbar">
    <strong>VibeExtract — Native macOS Capture</strong>
    <label><input type="checkbox" id="toggle-overlay" checked> AX overlay</label>
    <label><input type="checkbox" id="toggle-bg" checked> Screenshot</label>
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

fn render_html_boxes(node: &Node, root_bounds: (f64, f64, f64, f64), out: &mut String) {
    let (rx, ry, _, _) = root_bounds;
    if let Some((x, y, w, h)) = node.bounds {
        // Position relative to root.
        let lx = x - rx;
        let ly = y - ry;
        if w >= 1.0 && h >= 1.0 {
            let label = if !node.name.is_empty() {
                format!("{} \"{}\"", node.role, html_escape(&node.name))
            } else {
                node.role.clone()
            };
            let bg_style = match node.bg {
                Some((r, g, b)) => format!(" background-color: rgba({}, {}, {}, 0.10);", r, g, b),
                None => String::new(),
            };
            out.push_str(&format!(
                "<div class=\"ax-box\" data-role=\"{}\" style=\"left:{:.0}px; top:{:.0}px; width:{:.0}px; height:{:.0}px;{}\" title=\"{}\">{}</div>\n",
                html_escape(&node.role),
                lx, ly, w, h,
                bg_style,
                html_escape(&label),
                html_escape(&label_short(&node)),
            ));
        }
    }
    for kid in &node.children {
        render_html_boxes(kid, root_bounds, out);
    }
}

fn label_short(node: &Node) -> String {
    if !node.name.is_empty() {
        let trimmed: String = node.name.chars().take(40).collect();
        trimmed
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

// =============================================================================
// Color quantization for the palette section
// =============================================================================

fn collect_palette(node: &Node, palette: &mut Vec<(u8, u8, u8)>) {
    if let Some(c) = node.bg {
        // De-dupe near-identical samples (Δ < 8 per channel).
        let near = palette.iter().any(|p| {
            (p.0 as i32 - c.0 as i32).abs() < 8
                && (p.1 as i32 - c.1 as i32).abs() < 8
                && (p.2 as i32 - c.2 as i32).abs() < 8
        });
        if !near {
            palette.push(c);
        }
    }
    for kid in &node.children {
        collect_palette(kid, palette);
    }
}

// =============================================================================
// Main
// =============================================================================

fn main() -> Result<()> {
    let args = Args::parse();

    eprintln!("[native] checking AX permission...");
    if !check_ax_permission() {
        let _ = std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
            .status();
        bail!("AX permission denied — grant it in System Settings → Privacy & Security → Accessibility, then re-run.");
    }

    let cursor = match &args.cursor_screen {
        Some(s) => {
            let (xs, ys) = s.split_once(',').ok_or_else(|| anyhow!("--cursor-screen must be 'X,Y'"))?;
            let x: f64 = xs.trim().parse()?;
            let y: f64 = ys.trim().parse()?;
            CGPoint { x, y }
        }
        None => current_cursor(),
    };
    eprintln!("[native] cursor at screen ({:.0}, {:.0})", cursor.x, cursor.y);

    let system = unsafe { AXUIElementCreateSystemWide() };
    let root_el = element_under_cursor(system, cursor)
        .ok_or_else(|| anyhow!("no AX element at cursor — make sure the target app is frontmost and has accessibility support"))?;

    eprintln!("[native] walking AX subtree (max_depth={})...", args.max_depth);
    let mut root_node = capture_node(&root_el, 0, args.max_depth);
    let total = count_nodes(&root_node);
    eprintln!("[native] captured {} AX nodes", total);

    let bounds = root_node
        .bounds
        .ok_or_else(|| anyhow!("root element has no bounds — can't screenshot"))?;
    eprintln!(
        "[native] root: {} \"{}\" at ({:.0},{:.0}) {:.0}x{:.0}",
        root_node.role, root_node.name, bounds.0, bounds.1, bounds.2, bounds.3
    );

    std::fs::create_dir_all(&args.out_dir).context("creating out_dir")?;
    let png_path = args.out_dir.join("native-output.png");
    eprintln!("[native] capturing screenshot of root bounds to {}", png_path.display());
    screencapture_region(bounds, &png_path)
        .context("screencapture failed — does this binary have Screen Recording permission?")?;

    let img = image::open(&png_path)?.into_rgba8();
    eprintln!(
        "[native] screenshot loaded: {}×{} px (Retina scale = ~{}×)",
        img.width(),
        img.height(),
        ((img.width() as f64) / bounds.2.max(1.0)).round()
    );

    fill_sampled_colors(&mut root_node, &img, bounds);

    let mut palette = Vec::new();
    collect_palette(&root_node, &mut palette);
    eprintln!("[native] sampled palette: {} unique colors", palette.len());

    let toon = emit_toon(&root_node, &palette);
    let toon_path = args.out_dir.join("native-output.toon");
    std::fs::write(&toon_path, &toon).with_context(|| format!("writing {}", toon_path.display()))?;
    eprintln!("[native] wrote {} ({} bytes)", toon_path.display(), toon.len());

    let png_bytes = std::fs::read(&png_path)?;
    let png_b64 = base64::engine::general_purpose::STANDARD.encode(&png_bytes);
    let html = emit_html(&root_node, &png_b64, bounds);
    let html_path = args.out_dir.join("native-output.html");
    std::fs::write(&html_path, &html).with_context(|| format!("writing {}", html_path.display()))?;
    eprintln!("[native] wrote {} ({} bytes)", html_path.display(), html.len());

    eprintln!("[native] open {} in a browser to see the live composite (AX boxes overlaid on the screenshot — toggle each in the toolbar).", html_path.display());

    Ok(())
}

fn count_nodes(node: &Node) -> usize {
    1 + node.children.iter().map(count_nodes).sum::<usize>()
}
