//! Freeze a target app so a hover-dismissing panel (WPS PDF etc.) stays put while
//! the user's cursor moves freely.
//!
//! The trick is to **suspend the app's process** with `SIGSTOP`: its run loop can't
//! execute, so it can't close the panel or redraw — the panel is frozen exactly as
//! it was. The window server keeps compositing the app's last frame, so
//! `screencapture -l <window_id>` still captures it. The cursor is an OS-level thing,
//! untouched — it moves freely. `SIGCONT` resumes the app.
//!
//! Caveat for callers: a stopped app cannot answer **AX** queries (they're synchronous
//! IPC to the app's run loop, which is suspended → the call hangs). So briefly
//! `resume()` around any live AX work, then `suspend()` again.
//!
//! Limitation: `SIGSTOP`/`SIGCONT` act on the SINGLE pid given, not its process group
//! or children. For a multi-process app (Electron: main + renderer/helper pids) only
//! the pid passed is stopped. The picked app's *main* pid owns the panel window, so
//! stopping it is enough to hold the panel — but don't expect a whole-process-tree freeze.

/// Is `pid` a live process? Uses signal 0 (existence probe — delivers nothing).
/// `kill(pid, 0) == 0` means it exists and we may signal it; that's exactly the set of
/// processes we'd ever suspend/resume (our own target apps, same user).
pub fn is_alive(pid: i32) -> bool {
    pid > 0 && unsafe { libc::kill(pid, 0) == 0 }
}

/// Suspend the app (SIGSTOP). No-op for a dead/invalid pid so we never record a
/// recycled pid as "frozen" (which would later SIGCONT an unrelated new process).
pub fn suspend(pid: i32) {
    if is_alive(pid) {
        unsafe {
            libc::kill(pid, libc::SIGSTOP);
        }
    }
}

/// Resume a suspended app (SIGCONT). Safe to call on an already-running or dead pid
/// (a no-op / harmless), so resume paths can fire unconditionally.
pub fn resume(pid: i32) {
    if pid > 0 {
        unsafe {
            libc::kill(pid, libc::SIGCONT);
        }
    }
}
