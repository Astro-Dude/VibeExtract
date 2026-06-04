//! VibeExtract Desktop core library.
//!
//! All extraction logic lives here so the Tauri app, CLI demos, and (eventually)
//! tests can share the same code. The public surface is intentionally small:
//!
//! - [`capture::ScreenPoint`] / [`capture::PickedElement`] — what the picker returns
//! - [`picker::pick_under_cursor`] — hit-test using OS accessibility APIs
//! - [`dispatcher::extract`] — strategy-ladder dispatch (asar → CDP → XAML → NIB → AX → screenshot)
//! - [`output::CaptureResult`] — what the dispatcher returns: `{ toon, html, strategy }`
//!
//! Platform-specific modules live behind `cfg` gates. The Tauri app uses the
//! same `extract` function on every platform; the dispatcher chooses the
//! per-OS implementation internally.

pub mod capture;
pub mod dispatcher;
pub mod output;
pub mod picker;
pub mod sampling;

// Extraction strategies
pub mod cdp;
pub mod native_format;
pub mod screenshot;

#[cfg(target_os = "macos")]
pub mod ax_macos;
#[cfg(target_os = "macos")]
pub mod bundle_macos;
#[cfg(target_os = "macos")]
pub mod event_tap_macos;

#[cfg(target_os = "windows")]
pub mod uia_windows;
#[cfg(target_os = "windows")]
pub mod pe_windows;

pub mod asar;
pub mod dotnet_xaml;
pub mod electron_relaunch;
pub mod framework_detect;
pub mod settings;

// Cross-platform visual verifier + on-screen window enumeration. Used by the
// embedded MCP server to drive the automated UI-replication loop.
pub mod image_diff;
pub mod windows_list;

pub use dispatcher::{extract, ExtractError, Strategy};
pub use image_diff::{compare_images, DiffReport};
pub use output::CaptureResult;
pub use picker::{pick_under_cursor, PickedElement};
pub use windows_list::{list_windows, WindowInfo};
