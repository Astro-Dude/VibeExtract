//! Electron auto-relaunch orchestration.
//!
//! Electron apps (Slack, Discord, VS Code, Notion, WhatsApp, Teams, Cursor,
//! Linear, Obsidian, Figma) are Chromium under the hood. When a user launches
//! them normally the embedded Chromium does NOT open a DevTools port — so we
//! can't inject `contentScript.js` and our CDP path (`crate::cdp`) is dead.
//!
//! The fix is to relaunch the app with `--remote-debugging-port=N`. This module
//! owns the four steps:
//!   1. `quit_app_gently` — `osascript ... to quit` so the app saves drafts
//!   2. `launch_with_debug_port` — `open -a <name> --args --remote-debugging-port=N`
//!   3. `wait_for_cdp_ready` — poll `/json` until at least one page target is up
//!   4. `quit_and_relaunch` — wraps all three with progress events
//!
//! Apple's launch services do the actual quitting/spawning. We never `kill -9`
//! — that's the rule that protects unsaved drafts in VS Code, Linear, etc.

use anyhow::{anyhow, bail, Result};
use serde::Serialize;
use std::net::TcpListener;
use std::time::{Duration, Instant};

/// Bundle ids → display name + AppleScript aliases. The aliases are what we
/// feed to `osascript -e 'tell application "X" to quit'` and `open -a "X"`.
/// Some apps respond to multiple names (VS Code is both "Visual Studio Code"
/// and "Code") so we try each in order.
#[derive(Debug, Clone, Copy)]
pub struct KnownElectronApp {
    pub bundle_id: &'static str,
    pub display_name: &'static str,
    pub aliases: &'static [&'static str],
}

pub const KNOWN_ELECTRON_APPS: &[KnownElectronApp] = &[
    KnownElectronApp {
        bundle_id: "com.tinyspeck.slackmacgap",
        display_name: "Slack",
        aliases: &["Slack"],
    },
    KnownElectronApp {
        bundle_id: "com.hnc.Discord",
        display_name: "Discord",
        aliases: &["Discord"],
    },
    KnownElectronApp {
        bundle_id: "com.microsoft.VSCode",
        display_name: "Visual Studio Code",
        aliases: &["Visual Studio Code", "Code"],
    },
    KnownElectronApp {
        bundle_id: "com.todesktop.230313mzl4w4u92",
        display_name: "Cursor",
        aliases: &["Cursor"],
    },
    KnownElectronApp {
        bundle_id: "notion.id",
        display_name: "Notion",
        aliases: &["Notion"],
    },
    KnownElectronApp {
        // Verified 2026-06: `defaults read /Applications/WhatsApp.app/Contents/Info CFBundleIdentifier`
        // returns net.whatsapp.WhatsApp. The old "desktop.WhatsApp" was a
        // legacy id and caused lookup_known() to miss, dropping us into the
        // generic "unknown Electron app" dialog wording.
        bundle_id: "net.whatsapp.WhatsApp",
        display_name: "WhatsApp",
        aliases: &["WhatsApp"],
    },
    KnownElectronApp {
        bundle_id: "com.microsoft.teams2",
        display_name: "Microsoft Teams",
        aliases: &["Microsoft Teams"],
    },
    KnownElectronApp {
        bundle_id: "com.linear",
        display_name: "Linear",
        aliases: &["Linear"],
    },
    KnownElectronApp {
        bundle_id: "md.obsidian",
        display_name: "Obsidian",
        aliases: &["Obsidian"],
    },
    KnownElectronApp {
        bundle_id: "com.figma.Desktop",
        display_name: "Figma",
        aliases: &["Figma"],
    },
];

pub fn lookup_known(bundle_id: &str) -> Option<&'static KnownElectronApp> {
    KNOWN_ELECTRON_APPS.iter().find(|a| a.bundle_id == bundle_id)
}

/// What the orchestration layer needs to actually run a relaunch. Mostly
/// derived from the `BundleSummary` we already collect during dispatch.
#[derive(Debug, Clone)]
pub struct RelaunchTarget {
    pub bundle_id: String,
    pub display_name: String,
    /// AppleScript names. Static for known apps, fall back to `[display_name]`
    /// for unknown Electron apps.
    pub aliases: Vec<String>,
}

#[derive(Debug, thiserror::Error, Serialize)]
pub enum RelaunchError {
    #[error("{0} did not quit cleanly — save & quit manually, then retry")]
    QuitRefused(String),
    #[error("could not launch {0}: {1}")]
    LaunchFailed(String, String),
    #[error("{0} did not open a debug port within {1:?}")]
    CdpTimeout(String, Duration),
    #[error("{0}")]
    Other(String),
}

/// Find a free TCP port on 127.0.0.1 in the CDP scan range (9220..=9230 —
/// matches `crate::cdp::discover_port`). The relaunched app is then told to
/// expose that port via `--remote-debugging-port=N`. Returns the first port
/// that binds, defaulting to 9222.
///
/// There IS a tiny race window: another process could bind the port between
/// us releasing it and the app launching. Acceptable for v1 — if the app
/// fails to bind, `wait_for_cdp_ready` will just time out and the orchestration
/// layer falls through to the AX path.
pub fn pick_free_debug_port() -> u16 {
    for p in [9222u16, 9223, 9224, 9225, 9226, 9227, 9228, 9229, 9230, 9220, 9221] {
        if TcpListener::bind(("127.0.0.1", p)).is_ok() {
            return p;
        }
    }
    9222
}

/// Ask the app to quit via AppleScript so it saves state (vs. `kill -9`).
/// Returns once `lsappinfo` reports no live pid for the bundle id, or
/// `Err(QuitRefused)` after the 5s budget runs out.
///
/// "Refused" usually means the app popped a modal save dialog. We do NOT
/// escalate — losing an unsaved buffer is worse than a slightly worse capture.
#[cfg(target_os = "macos")]
pub async fn quit_app_gently(aliases: &[String], bundle_id: &str) -> Result<(), RelaunchError> {
    let mut last_err = String::new();
    let mut any_attempt_ok = false;
    for alias in aliases {
        let script = format!(r#"tell application "{}" to quit"#, alias);
        let out = std::process::Command::new("/usr/bin/osascript")
            .args(["-e", &script])
            .output();
        match out {
            Ok(o) => {
                if o.status.success() {
                    any_attempt_ok = true;
                    log::info!("electron_relaunch: osascript quit {:?} ok", alias);
                    break;
                } else {
                    last_err = String::from_utf8_lossy(&o.stderr).to_string();
                    log::warn!("electron_relaunch: osascript quit {:?} failed: {}", alias, last_err);
                }
            }
            Err(e) => {
                last_err = e.to_string();
            }
        }
    }
    if !any_attempt_ok {
        return Err(RelaunchError::QuitRefused(format!(
            "no AppleScript alias worked ({})",
            last_err
        )));
    }

    // Poll until the pid is gone. 200ms tick × 25 = 5s budget. lsappinfo is
    // fast (~10ms cold) so this loop is cheap.
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if !pid_alive_for_bundle(bundle_id) {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    Err(RelaunchError::QuitRefused(format!(
        "{} still alive after 5s — likely a modal save dialog is blocking quit",
        bundle_id
    )))
}

#[cfg(not(target_os = "macos"))]
pub async fn quit_app_gently(_aliases: &[String], _bundle_id: &str) -> Result<(), RelaunchError> {
    Err(RelaunchError::Other(
        "electron_relaunch only supported on macOS today".into(),
    ))
}

/// Returns true iff `lsappinfo` reports a live process for this bundle id.
/// We ask by bundle id (not pid) because pids change every relaunch, and
/// lsappinfo's bundle-id lookup is more reliable than `pgrep -f`.
#[cfg(target_os = "macos")]
fn pid_alive_for_bundle(bundle_id: &str) -> bool {
    let out = std::process::Command::new("/usr/bin/lsappinfo")
        .args(["info", "-only", "pid", "-app", bundle_id])
        .output();
    match out {
        Ok(o) => {
            let text = String::from_utf8_lossy(&o.stdout);
            // lsappinfo prints something like `"pid"=12345` on a live app and
            // nothing (or just whitespace) once it's gone.
            text.lines().any(|line| {
                if let Some(eq) = line.find('=') {
                    line[eq + 1..]
                        .trim()
                        .parse::<i32>()
                        .ok()
                        .map(|n| n > 0)
                        .unwrap_or(false)
                } else {
                    false
                }
            })
        }
        Err(_) => false,
    }
}

/// `open -a <Display Name> --args --remote-debugging-port=<port>`.
/// macOS routes this through launch services, which finds the .app bundle
/// even if the user moved it from /Applications. Returns once `open` returns
/// (the app may still be starting up — that's `wait_for_cdp_ready`'s job).
#[cfg(target_os = "macos")]
pub async fn launch_with_debug_port(display_name: &str, port: u16) -> Result<(), RelaunchError> {
    let out = std::process::Command::new("/usr/bin/open")
        .args([
            "-a",
            display_name,
            "--args",
            &format!("--remote-debugging-port={}", port),
        ])
        .output()
        .map_err(|e| RelaunchError::LaunchFailed(display_name.to_string(), e.to_string()))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        return Err(RelaunchError::LaunchFailed(
            display_name.to_string(),
            stderr,
        ));
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub async fn launch_with_debug_port(_display_name: &str, _port: u16) -> Result<(), RelaunchError> {
    Err(RelaunchError::Other(
        "electron_relaunch only supported on macOS today".into(),
    ))
}

/// One-line tick payload emitted via the `progress` callback during the wait
/// loop, so the UI can show a spinner with elapsed-ms feedback.
#[derive(Debug, Clone, Serialize)]
pub struct RelaunchProgress {
    pub phase: &'static str,
    pub elapsed_ms: u64,
    pub port: u16,
}

/// Poll `http://127.0.0.1:{port}/json` every 250ms until we see at least one
/// `target_type=="page"` entry — that means Chromium is up and DevTools is
/// listening. Calls `progress` on every tick so the UI can render a spinner.
///
/// `timeout` of 10s is generous — typical relaunch is 2–5s.
pub async fn wait_for_cdp_ready<F>(
    display_name: &str,
    port: u16,
    timeout: Duration,
    mut progress: F,
) -> Result<(), RelaunchError>
where
    F: FnMut(RelaunchProgress),
{
    let start = Instant::now();
    let client = reqwest::Client::new();
    loop {
        let elapsed = start.elapsed();
        progress(RelaunchProgress {
            phase: "waiting",
            elapsed_ms: elapsed.as_millis() as u64,
            port,
        });
        if elapsed >= timeout {
            return Err(RelaunchError::CdpTimeout(display_name.to_string(), timeout));
        }

        if let Ok(resp) = client
            .get(format!("http://127.0.0.1:{port}/json"))
            .timeout(Duration::from_millis(500))
            .send()
            .await
        {
            if resp.status().is_success() {
                if let Ok(text) = resp.text().await {
                    // Use serde_json::Value to be tolerant of CDP version drift —
                    // we only need to confirm at least one entry has type=="page".
                    if let Ok(arr) = serde_json::from_str::<serde_json::Value>(&text) {
                        let has_page = arr
                            .as_array()
                            .map(|a| {
                                a.iter().any(|t| {
                                    t.get("type")
                                        .and_then(|v| v.as_str())
                                        .map(|s| s == "page")
                                        .unwrap_or(false)
                                })
                            })
                            .unwrap_or(false);
                        if has_page {
                            progress(RelaunchProgress {
                                phase: "ready",
                                elapsed_ms: elapsed.as_millis() as u64,
                                port,
                            });
                            return Ok(());
                        }
                    }
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// The full happy path. Quits the app, picks a free CDP port, launches it
/// with that port, waits up to 10s for DevTools to come up. Returns the port
/// on success so the dispatcher can use it directly without re-discovering.
///
/// On any leg failing we surface the typed error — the orchestration layer
/// (in `app/src-tauri/src/lib.rs`) is responsible for toast wording.
pub async fn quit_and_relaunch<F>(
    target: &RelaunchTarget,
    mut progress: F,
) -> Result<u16, RelaunchError>
where
    F: FnMut(RelaunchProgress),
{
    progress(RelaunchProgress {
        phase: "quitting",
        elapsed_ms: 0,
        port: 0,
    });
    let aliases: Vec<String> = target.aliases.clone();
    quit_app_gently(&aliases, &target.bundle_id).await?;

    let port = pick_free_debug_port();
    progress(RelaunchProgress {
        phase: "launching",
        elapsed_ms: 0,
        port,
    });
    launch_with_debug_port(&target.display_name, port).await?;

    wait_for_cdp_ready(
        &target.display_name,
        port,
        Duration::from_secs(10),
        |p| progress(p),
    )
    .await?;

    Ok(port)
}

/// Convenience constructor used by the dispatcher and the orchestration layer
/// to build a `RelaunchTarget` from whatever we already know about the app
/// (its `BundleSummary` if we have one, else the display name we synthesised
/// from the executable path).
pub fn make_target(
    bundle_id: Option<&str>,
    fallback_display: &str,
) -> Result<RelaunchTarget> {
    if let Some(bid) = bundle_id {
        if let Some(known) = lookup_known(bid) {
            return Ok(RelaunchTarget {
                bundle_id: known.bundle_id.to_string(),
                display_name: known.display_name.to_string(),
                aliases: known.aliases.iter().map(|s| s.to_string()).collect(),
            });
        }
        // Unknown bundle id but it IS Electron — try the display name as
        // both bundle id (for settings keying) and AppleScript alias.
        return Ok(RelaunchTarget {
            bundle_id: bid.to_string(),
            display_name: fallback_display.to_string(),
            aliases: vec![fallback_display.to_string()],
        });
    }
    if fallback_display.is_empty() {
        bail!("no bundle id and no display name — can't build RelaunchTarget");
    }
    Ok(RelaunchTarget {
        bundle_id: fallback_display.to_string(),
        display_name: fallback_display.to_string(),
        aliases: vec![fallback_display.to_string()],
    })
}

#[allow(dead_code)]
fn _ensure_anyhow_used() -> Result<()> {
    Err(anyhow!("unused"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lookup_known_apps() {
        assert_eq!(
            lookup_known("com.tinyspeck.slackmacgap").map(|k| k.display_name),
            Some("Slack")
        );
        assert!(lookup_known("com.does.not.exist").is_none());
    }

    #[test]
    fn whatsapp_uses_correct_bundle_id() {
        // Real WhatsApp Desktop bundle id is net.whatsapp.WhatsApp; the
        // legacy "desktop.WhatsApp" was previously listed (incorrectly).
        let found = lookup_known("net.whatsapp.WhatsApp");
        assert!(
            found.is_some(),
            "WhatsApp must be in KNOWN_ELECTRON_APPS under its real bundle id"
        );
        assert_eq!(found.unwrap().display_name, "WhatsApp");
        assert!(
            lookup_known("desktop.WhatsApp").is_none(),
            "legacy WhatsApp bundle id must no longer match"
        );
    }

    #[test]
    fn make_target_known() {
        let t = make_target(Some("com.hnc.Discord"), "Discord").unwrap();
        assert_eq!(t.display_name, "Discord");
        assert_eq!(t.aliases, vec!["Discord".to_string()]);
    }

    #[test]
    fn make_target_unknown_uses_fallback() {
        let t = make_target(Some("dev.unknown.electron"), "Unknown").unwrap();
        assert_eq!(t.display_name, "Unknown");
        assert_eq!(t.bundle_id, "dev.unknown.electron");
    }

    #[test]
    fn pick_free_debug_port_returns_something_in_range() {
        let p = pick_free_debug_port();
        assert!((9220..=9230).contains(&p));
    }
}
