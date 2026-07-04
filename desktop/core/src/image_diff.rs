//! Visual self-verification for the UI-replication loop.
//!
//! Compares a native screenshot (captured by `screenshot::capture_region_b64`)
//! against a screenshot of the generated HTML+CSS replica (rendered by the
//! Playwright MCP) and returns a similarity score plus a red diff heatmap PNG.
//!
//! ## The one rule that makes this correct
//! Native screenshots come out at **device pixels** (Retina = 2× the point-space
//! `ScreenRect` that AX reports), while the replica is rendered at **CSS pixels**.
//! So the two inputs almost never share dimensions. Every comparison therefore
//! **resizes both inputs to a common canvas first** — that single step absorbs
//! the Retina factor and any minor sizing drift, so the diff is apples-to-apples.
//!
//! Pure Rust over the `image` crate (already a dependency); no new deps.

use anyhow::{Context, Result};
use base64::Engine as _;
use image::{imageops::FilterType, DynamicImage, Rgba, RgbaImage};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Which similarity metric drives the headline `score_0_1`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Metric {
    /// Structural similarity on luma — tolerant of anti-aliasing, sub-pixel and
    /// scale artifacts. The default gate for the replication loop.
    Ssim,
    /// `1 - mean_abs_err/255`. Cheaper, harsher on color shifts.
    Mae,
}

impl Default for Metric {
    fn default() -> Self {
        Metric::Ssim
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct DiffOptions {
    pub metric: Metric,
    /// A pixel counts toward `mismatch_fraction` when its max per-channel
    /// absolute difference exceeds this (0–255).
    pub per_pixel_threshold: u8,
    /// Cap on the longer edge of the common canvas. Bounds CPU + heatmap size.
    pub max_edge: u32,
}

impl Default for DiffOptions {
    fn default() -> Self {
        Self {
            metric: Metric::Ssim,
            per_pixel_threshold: 16,
            max_edge: 1024,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiffReport {
    /// Headline similarity in 0..1 (1.0 = identical). Driven by `method`.
    pub score_0_1: f64,
    /// "ssim" | "mae" — which metric produced `score_0_1`.
    pub method: String,
    /// Common-canvas dimensions the comparison ran at (post-resize).
    pub width: u32,
    pub height: u32,
    /// Mean absolute per-channel difference, 0..255 (independent of `method`).
    pub mean_abs_err: f64,
    /// Fraction of pixels exceeding `per_pixel_threshold`, 0..1.
    pub mismatch_fraction: f64,
    /// Base64 PNG heatmap: brighter red = larger local difference.
    pub diff_png_b64: String,
}

/// Convenience: compare two in-memory PNGs (or any `image`-decodable bytes)
/// with default options.
pub fn compare_images(a: &[u8], b: &[u8]) -> Result<DiffReport> {
    compare_bytes(a, b, &DiffOptions::default())
}

/// Compare two PNG files on disk.
pub fn compare_paths(a: &Path, b: &Path, opts: &DiffOptions) -> Result<DiffReport> {
    let a_bytes = std::fs::read(a).with_context(|| format!("reading {}", a.display()))?;
    let b_bytes = std::fs::read(b).with_context(|| format!("reading {}", b.display()))?;
    compare_bytes(&a_bytes, &b_bytes, opts)
}

/// The core comparison. Decodes both inputs, resizes both to a shared canvas,
/// then computes the score, MAE, mismatch fraction and a heatmap.
pub fn compare_bytes(a: &[u8], b: &[u8], opts: &DiffOptions) -> Result<DiffReport> {
    let a_img = image::load_from_memory(a)
        .context("decoding first image")?
        .to_rgba8();
    let b_img = image::load_from_memory(b)
        .context("decoding second image")?
        .to_rgba8();

    let (tw, th) = common_canvas(a_img.width(), a_img.height(), opts.max_edge.max(1));
    let a_r = resize_if_needed(&a_img, tw, th);
    let b_r = resize_if_needed(&b_img, tw, th);

    // Per-pixel pass: MAE, mismatch fraction, and the heatmap in one walk.
    let mut heatmap = RgbaImage::new(tw, th);
    let mut sum_abs: f64 = 0.0;
    let mut mismatched: u64 = 0;
    let total_pixels = (tw as u64) * (th as u64);
    for y in 0..th {
        for x in 0..tw {
            let pa = a_r.get_pixel(x, y);
            let pb = b_r.get_pixel(x, y);
            let dr = (pa[0] as i32 - pb[0] as i32).unsigned_abs();
            let dg = (pa[1] as i32 - pb[1] as i32).unsigned_abs();
            let db = (pa[2] as i32 - pb[2] as i32).unsigned_abs();
            sum_abs += (dr + dg + db) as f64;
            let dmax = dr.max(dg).max(db) as u8;
            if dmax > opts.per_pixel_threshold {
                mismatched += 1;
            }
            heatmap.put_pixel(x, y, Rgba([dmax, 0, 0, 255]));
        }
    }
    let mean_abs_err = if total_pixels == 0 {
        0.0
    } else {
        sum_abs / (total_pixels as f64 * 3.0)
    };
    let mismatch_fraction = if total_pixels == 0 {
        0.0
    } else {
        mismatched as f64 / total_pixels as f64
    };

    let (score_0_1, method) = match opts.metric {
        Metric::Mae => (1.0 - (mean_abs_err / 255.0), "mae"),
        Metric::Ssim => (block_ssim_luma(&a_r, &b_r).clamp(0.0, 1.0), "ssim"),
    };

    let mut png = Vec::new();
    DynamicImage::ImageRgba8(heatmap)
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .context("encoding diff heatmap PNG")?;
    let diff_png_b64 = base64::engine::general_purpose::STANDARD.encode(&png);

    Ok(DiffReport {
        score_0_1,
        method: method.to_string(),
        width: tw,
        height: th,
        mean_abs_err,
        mismatch_fraction,
        diff_png_b64,
    })
}

/// Target dimensions: image A's shape, scaled down so the long edge fits
/// `max_edge`. Both inputs are then resized to this so they share a grid.
fn common_canvas(w: u32, h: u32, max_edge: u32) -> (u32, u32) {
    let w = w.max(1);
    let h = h.max(1);
    let long = w.max(h);
    if long <= max_edge {
        return (w, h);
    }
    let s = max_edge as f64 / long as f64;
    let tw = ((w as f64 * s).round() as u32).max(1);
    let th = ((h as f64 * s).round() as u32).max(1);
    (tw, th)
}

fn resize_if_needed(img: &RgbaImage, tw: u32, th: u32) -> RgbaImage {
    if img.width() == tw && img.height() == th {
        img.clone()
    } else {
        image::imageops::resize(img, tw, th, FilterType::Triangle)
    }
}

/// Mean SSIM over non-overlapping 8×8 blocks of the luma channel.
fn block_ssim_luma(a: &RgbaImage, b: &RgbaImage) -> f64 {
    const C1: f64 = 6.5025; // (0.01 * 255)^2
    const C2: f64 = 58.5225; // (0.03 * 255)^2
    const BLK: u32 = 8;

    let (w, h) = (a.width(), a.height());
    if w == 0 || h == 0 {
        return 1.0;
    }
    let luma = |p: &Rgba<u8>| -> f64 {
        0.299 * p[0] as f64 + 0.587 * p[1] as f64 + 0.114 * p[2] as f64
    };

    let mut acc = 0.0;
    let mut blocks = 0u64;
    let mut by = 0;
    while by < h {
        let mut bx = 0;
        while bx < w {
            let x1 = (bx + BLK).min(w);
            let y1 = (by + BLK).min(h);
            let mut sx = 0.0;
            let mut sy = 0.0;
            let mut sxx = 0.0;
            let mut syy = 0.0;
            let mut sxy = 0.0;
            let mut n = 0.0;
            for y in by..y1 {
                for x in bx..x1 {
                    let xv = luma(a.get_pixel(x, y));
                    let yv = luma(b.get_pixel(x, y));
                    sx += xv;
                    sy += yv;
                    sxx += xv * xv;
                    syy += yv * yv;
                    sxy += xv * yv;
                    n += 1.0;
                }
            }
            if n > 0.0 {
                let mux = sx / n;
                let muy = sy / n;
                let varx = (sxx / n) - mux * mux;
                let vary = (syy / n) - muy * muy;
                let cov = (sxy / n) - mux * muy;
                let num = (2.0 * mux * muy + C1) * (2.0 * cov + C2);
                let den = (mux * mux + muy * muy + C1) * (varx + vary + C2);
                acc += if den != 0.0 { num / den } else { 1.0 };
                blocks += 1;
            }
            bx += BLK;
        }
        by += BLK;
    }
    if blocks == 0 {
        1.0
    } else {
        acc / blocks as f64
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgba};

    /// Encode an RgbaImage to PNG bytes (test helper).
    fn png_bytes(img: &RgbaImage) -> Vec<u8> {
        let mut out = Vec::new();
        DynamicImage::ImageRgba8(img.clone())
            .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
            .unwrap();
        out
    }

    /// A simple diagonal gradient so SSIM has real structure to chew on.
    fn gradient(w: u32, h: u32) -> RgbaImage {
        ImageBuffer::from_fn(w, h, |x, y| {
            let v = (((x + y) * 255) / (w + h).max(1)) as u8;
            Rgba([v, (255 - v) as u8, (x % 256) as u8, 255])
        })
    }

    #[test]
    fn identical_images_score_one_and_black_heatmap() {
        let img = gradient(64, 48);
        let bytes = png_bytes(&img);
        let r = compare_images(&bytes, &bytes).unwrap();
        assert!(r.score_0_1 > 0.999, "identical should score ~1.0, got {}", r.score_0_1);
        assert_eq!(r.mismatch_fraction, 0.0);
        assert_eq!(r.mean_abs_err, 0.0);
        // Heatmap must be all-black (every channel-diff is zero).
        let heat = image::load_from_memory(
            &base64::engine::general_purpose::STANDARD
                .decode(r.diff_png_b64)
                .unwrap(),
        )
        .unwrap()
        .to_rgba8();
        assert!(heat.pixels().all(|p| p[0] == 0));
    }

    #[test]
    fn retina_upscale_still_matches() {
        // Native (2x) vs replica (1x) of the SAME content: after the
        // resize-to-common-canvas step, the score must stay high.
        let small = gradient(40, 30);
        let big = image::imageops::resize(&small, 80, 60, FilterType::Triangle);
        let r = compare_bytes(&png_bytes(&big), &png_bytes(&small), &DiffOptions::default()).unwrap();
        assert!(
            r.score_0_1 > 0.95,
            "2x upscale of same content should still score high, got {}",
            r.score_0_1
        );
    }

    #[test]
    fn half_inverted_has_half_mismatch() {
        let w = 64;
        let h = 64;
        let base = ImageBuffer::from_fn(w, h, |_x, _y| Rgba([200u8, 200, 200, 255]));
        // Right half flipped to near-black.
        let modified = ImageBuffer::from_fn(w, h, |x, _y| {
            if x >= w / 2 {
                Rgba([10u8, 10, 10, 255])
            } else {
                Rgba([200u8, 200, 200, 255])
            }
        });
        let r =
            compare_bytes(&png_bytes(&base), &png_bytes(&modified), &DiffOptions::default()).unwrap();
        assert!(
            (r.mismatch_fraction - 0.5).abs() < 0.05,
            "expected ~0.5 mismatch fraction, got {}",
            r.mismatch_fraction
        );
        assert!(r.score_0_1 < 0.9, "half-inverted should not pass, got {}", r.score_0_1);
    }
}
