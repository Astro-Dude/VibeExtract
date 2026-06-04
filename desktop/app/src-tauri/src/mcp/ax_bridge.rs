//! Thread-safety bridge for Accessibility calls.
//!
//! macOS AX queries materialize a non-`Send` `AxElement` (a raw
//! `AXUIElementRef`). The MCP tool bodies are `async`, so we must never hold
//! such a handle across an `.await`. Every helper here does all its AX work
//! inside a `tokio::task::spawn_blocking` closure that creates, walks, and
//! drops the handle synchronously, returning only `Send` JSON. This mirrors the
//! existing `spawn_hover_task` pattern in `lib.rs`.
//!
//! Each helper returns `serde_json::Value` (not `Node`/`PickedElement`) so the
//! signatures are identical across platforms — `Node` is itself macOS-only.

use serde_json::Value;

/// Run an AX closure off the async runtime. The closure owns and drops every
/// non-`Send` handle before returning `Send` JSON.
async fn run_ax<F>(f: F) -> Result<Value, String>
where
    F: FnOnce() -> Result<Value, String> + Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("AX worker thread panicked or was cancelled: {e}"))?
}

pub async fn frontmost_app() -> Result<Value, String> {
    run_ax(imp::frontmost_app).await
}

pub async fn ax_tree(pid: i32, max_depth: u32, window_index: Option<usize>) -> Result<Value, String> {
    run_ax(move || imp::ax_tree(pid, max_depth, window_index)).await
}

pub async fn node_at_point(x: f64, y: f64, pid: Option<i32>) -> Result<Value, String> {
    run_ax(move || imp::node_at_point(x, y, pid)).await
}

pub async fn subtree_at_point(x: f64, y: f64, max_depth: u32) -> Result<Value, String> {
    run_ax(move || imp::subtree_at_point(x, y, max_depth)).await
}

pub async fn palette(pid: i32, max_depth: u32) -> Result<Value, String> {
    run_ax(move || imp::palette(pid, max_depth)).await
}

/// Typed pick (needed by `extract_component`, which feeds the dispatcher).
/// `PickedElement` is cross-platform and `Send`, so it's safe to return.
pub async fn pick_element(
    x: f64,
    y: f64,
    pid: Option<i32>,
) -> Result<vibe_extract_core::PickedElement, String> {
    tokio::task::spawn_blocking(move || imp::pick_element(x, y, pid))
        .await
        .map_err(|e| format!("AX worker thread panicked or was cancelled: {e}"))?
}

// --- macOS implementation ----------------------------------------------------

#[cfg(target_os = "macos")]
mod imp {
    use serde_json::{json, Value};
    use vibe_extract_core::ax_macos::{self, WindowSelector};
    use vibe_extract_core::capture::ScreenPoint;

    fn require_permission() -> Result<(), String> {
        if ax_macos::check_permission(false) {
            Ok(())
        } else {
            Err("Accessibility permission not granted — call request_ax_permission, \
                 then grant VibeExtract in System Settings → Privacy → Accessibility."
                .into())
        }
    }

    pub fn frontmost_app() -> Result<Value, String> {
        let pid = ax_macos::frontmost_app_pid().ok_or("no frontmost application")?;
        Ok(json!({
            "pid": pid,
            "app_path": ax_macos::pid_to_path(pid),
            "name": crate::app_name_for_pid(pid),
        }))
    }

    pub fn ax_tree(pid: i32, max_depth: u32, window_index: Option<usize>) -> Result<Value, String> {
        require_permission()?;
        let node = match window_index {
            Some(i) => ax_macos::walk_window(pid, WindowSelector::Index(i), max_depth),
            None => ax_macos::walk_app(pid, max_depth),
        }
        .map_err(|e| e.to_string())?;
        serde_json::to_value(&node).map_err(|e| e.to_string())
    }

    pub fn node_at_point(x: f64, y: f64, pid: Option<i32>) -> Result<Value, String> {
        require_permission()?;
        let pt = ScreenPoint { x, y };
        let picked = match pid {
            Some(p) => ax_macos::pick_in_app(pt, p),
            None => ax_macos::pick(pt),
        }
        .map_err(|e| e.to_string())?;
        serde_json::to_value(&picked).map_err(|e| e.to_string())
    }

    pub fn subtree_at_point(x: f64, y: f64, max_depth: u32) -> Result<Value, String> {
        require_permission()?;
        let node = ax_macos::walk_subtree(ScreenPoint { x, y }, max_depth).map_err(|e| e.to_string())?;
        serde_json::to_value(&node).map_err(|e| e.to_string())
    }

    pub fn palette(pid: i32, max_depth: u32) -> Result<Value, String> {
        require_permission()?;
        let pal = ax_macos::window_palette(pid, max_depth).map_err(|e| e.to_string())?;
        let hex: Vec<String> = pal
            .iter()
            .map(|(r, g, b)| format!("#{:02x}{:02x}{:02x}", r, g, b))
            .collect();
        Ok(json!({ "palette_hex": hex, "palette_rgb": pal }))
    }

    pub fn pick_element(
        x: f64,
        y: f64,
        pid: Option<i32>,
    ) -> Result<vibe_extract_core::PickedElement, String> {
        require_permission()?;
        let pt = ScreenPoint { x, y };
        match pid {
            Some(p) => ax_macos::pick_in_app(pt, p),
            None => ax_macos::pick(pt),
        }
        .map_err(|e| e.to_string())
    }
}

// --- Non-macOS stubs ---------------------------------------------------------

#[cfg(not(target_os = "macos"))]
mod imp {
    use serde_json::Value;

    const MSG: &str = "Accessibility tools are not implemented on this platform yet (macOS only).";

    pub fn frontmost_app() -> Result<Value, String> {
        Err(MSG.into())
    }
    pub fn ax_tree(_pid: i32, _max_depth: u32, _window_index: Option<usize>) -> Result<Value, String> {
        Err(MSG.into())
    }
    pub fn node_at_point(_x: f64, _y: f64, _pid: Option<i32>) -> Result<Value, String> {
        Err(MSG.into())
    }
    pub fn subtree_at_point(_x: f64, _y: f64, _max_depth: u32) -> Result<Value, String> {
        Err(MSG.into())
    }
    pub fn palette(_pid: i32, _max_depth: u32) -> Result<Value, String> {
        Err(MSG.into())
    }
    pub fn pick_element(
        _x: f64,
        _y: f64,
        _pid: Option<i32>,
    ) -> Result<vibe_extract_core::PickedElement, String> {
        Err(MSG.into())
    }
}
