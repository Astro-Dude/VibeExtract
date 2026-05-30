//! Per-element background-color sampling. Given a screenshot PNG of the root
//! element and the bounds-tree, sample pixel colors at the center of each child.

use crate::capture::ScreenRect;

pub fn sample_at(
    img: &image::RgbaImage,
    root_bounds: ScreenRect,
    x: f64,
    y: f64,
) -> Option<(u8, u8, u8)> {
    if !root_bounds.is_valid() {
        return None;
    }
    let rel_x = (x - root_bounds.x) / root_bounds.w;
    let rel_y = (y - root_bounds.y) / root_bounds.h;
    if !(0.0..=1.0).contains(&rel_x) || !(0.0..=1.0).contains(&rel_y) {
        return None;
    }
    let (iw, ih) = (img.width() as f64, img.height() as f64);
    let ix = (rel_x * iw).clamp(0.0, iw - 1.0) as u32;
    let iy = (rel_y * ih).clamp(0.0, ih - 1.0) as u32;
    let p = img.get_pixel(ix, iy);
    Some((p[0], p[1], p[2]))
}

/// Walk an [`crate::ax_macos::Node`] tree and fill in `.bg` for each node.
#[cfg(target_os = "macos")]
pub fn fill_node_colors(
    node: &mut crate::ax_macos::Node,
    img: &image::RgbaImage,
    root_bounds: ScreenRect,
) {
    if let Some(b) = node.bounds {
        let c = b.center();
        node.bg = sample_at(img, root_bounds, c.x, c.y);
    }
    for kid in &mut node.children {
        fill_node_colors(kid, img, root_bounds);
    }
}

/// Collect a deduped palette of all sampled colors in the tree.
#[cfg(target_os = "macos")]
pub fn collect_palette(node: &crate::ax_macos::Node, out: &mut Vec<(u8, u8, u8)>) {
    if let Some(c) = node.bg {
        let near = out.iter().any(|p| {
            (p.0 as i32 - c.0 as i32).abs() < 8
                && (p.1 as i32 - c.1 as i32).abs() < 8
                && (p.2 as i32 - c.2 as i32).abs() < 8
        });
        if !near {
            out.push(c);
        }
    }
    for kid in &node.children {
        collect_palette(kid, out);
    }
}
