//! Overlay event dispatch + native macOS Liquid Glass renderer.
//!
//! The backend emits every overlay visual update as an `overlay:event`. A single
//! Rust-side listener (registered in `lib.rs`) forwards those same events here via
//! [`handle_event`]. On Windows this is a no-op (the WebviewWindow is the sole
//! renderer, hosting the React overlay). On macOS the overlay is a WebView-less
//! native Window; the event drives an AppKit pill rendered *inside* an
//! `NSGlassEffectView`, so the transcript text gets the OS's built-in,
//! content-aware legibility adaptation (the whole point of the native renderer).

pub(crate) mod shared;

use std::sync::Arc;
use std::time::Duration;

use tauri::{App, AppHandle, Emitter, Manager};

use crate::app_state;
use crate::hotkey;

/// Forward an `overlay:event` to the native macOS renderer. No-op elsewhere.
#[allow(unused_variables)]
pub fn handle_event(app: &AppHandle, event: &serde_json::Value) {
    #[cfg(target_os = "macos")]
    macos::dispatch(app, event);
}

/// Remember the app the user is currently working in, so we can hand keyboard
/// focus back to it after a retry (clicking the native retry button activates the
/// overlay, which would otherwise swallow the paste). No-op off macOS.
#[allow(unused_variables)]
pub fn capture_foreground_app(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    macos::capture_foreground_app(app);
}

/// Reactivate the app captured by [`capture_foreground_app`] so the subsequent
/// paste lands in the window the user was in. No-op off macOS.
#[allow(unused_variables)]
pub fn restore_foreground_app(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    macos::restore_foreground_app(app);
}

/// Create the overlay window in code. tauri.conf.json declares it with
/// `create: false`; macOS builds a WebView-less native Window (the pill is
/// rendered natively by overlay.rs), while Windows builds a WebviewWindow that
/// hosts the React overlay. Window properties (cursor_events,
/// visible_on_all_workspaces, position) are still applied in position_overlay()
/// at RunEvent::Ready to avoid "Window move completed without beginning" on macOS.
pub(crate) fn setup_overlay_window(app: &App) {
    #[cfg(target_os = "macos")]
    {
        use tauri::window::WindowBuilder;
        let _ = WindowBuilder::new(app, "overlay")
            .title("VoicePaste")
            .inner_size(720.0, 300.0)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .resizable(false)
            .visible(false)
            .skip_taskbar(true)
            .shadow(false)
            .build();
    }
    #[cfg(not(target_os = "macos"))]
    {
        use tauri::{WebviewUrl, WebviewWindowBuilder};
        let _ = WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App("index.html".into()))
            .title("VoicePaste")
            .inner_size(720.0, 300.0)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .resizable(false)
            .visible(false)
            .skip_taskbar(true)
            .shadow(false)
            .focusable(false)
            .build();
    }
}

/// Position the overlay at bottom-center of the primary screen.
///
/// Called from RunEvent::Ready (to avoid macOS window server timing warnings) and
/// again every time the overlay is about to be shown. Re-running it on each show is
/// what lets the overlay follow display changes: when an external monitor is plugged
/// in or unplugged the primary monitor (and its work area) changes, but the window
/// keeps its old frame until repositioned — which previously required an app restart.
pub(crate) fn position_overlay(app_handle: &AppHandle) {
    if let Some(overlay) = app_handle.get_window("overlay") {
        // Set window properties here (RunEvent::Ready) rather than during setup()
        // to avoid macOS window server timing issues.
        let _ = overlay.set_ignore_cursor_events(true);
        let _ = overlay.set_visible_on_all_workspaces(true);

        // Use the PRIMARY monitor's WORK AREA in LOGICAL units. The previous code
        // used physical pixels, which on a Retina (2x) display shrank the window to
        // half size and mispositioned it, and it measured from the full screen
        // height instead of the work area (ignoring the Dock / menu bar).
        if let Ok(Some(monitor)) = overlay.primary_monitor() {
            let scale = monitor.scale_factor();
            let work_area = monitor.work_area();
            let wa_x = work_area.position.x as f64 / scale;
            let wa_y = work_area.position.y as f64 / scale;
            let wa_w = work_area.size.width as f64 / scale;
            let wa_h = work_area.size.height as f64 / scale;

            let overlay_width = 720.0f64;
            let overlay_height = 300.0f64;
            let x = wa_x + (wa_w - overlay_width) / 2.0;
            let y = wa_y + wa_h - overlay_height - 48.0;

            let _ = overlay.set_size(tauri::Size::Logical(tauri::LogicalSize::new(
                overlay_width,
                overlay_height,
            )));
            let _ =
                overlay.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(x, y)));
        }
    }
}

pub(crate) fn set_overlay_retry_interaction(app_handle: &AppHandle, enabled: bool) {
    if let Some(overlay) = app_handle.get_window("overlay") {
        let _ = overlay.set_ignore_cursor_events(!enabled);
    }
    if enabled {
        // The user's app is still frontmost here; remember it so a successful retry
        // can return focus before pasting (clicking the retry button activates the
        // overlay otherwise). Self-capture is filtered out inside the helper.
        capture_foreground_app(app_handle);
    }
}

/// Emit a retryable error hint, tagged with the main hotkey label so the overlay
/// can show which key (also) triggers the retry. Centralizes every failure path.
pub(crate) async fn emit_retryable_error_hint(
    app: &AppHandle,
    app_inner: &Arc<app_state::AppInner>,
    text: &str,
) {
    let hotkey = hotkey::current_hotkey_label(app_inner).await;
    let _ = app.emit(
        "overlay:event",
        serde_json::json!({
            "type": "hint",
            "payload": {
                "text": text,
                "level": "error",
                "variant": "text",
                "retryable": true,
                "hotkey": hotkey
            }
        }),
    );
}

pub(crate) fn schedule_retry_overlay_hide(
    app_handle: AppHandle,
    app_inner: Arc<app_state::AppInner>,
) {
    // While the retry is shown (idle), keep ESC live so it can dismiss the failure.
    // set_app_state(Idle) just disabled it, so re-enable it here.
    set_escape_enabled_now(&app_handle, true);
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(5)).await;
        let still_idle = {
            let s = app_inner.state.lock().await;
            matches!(*s, app_state::AppState::Idle)
        };
        if still_idle {
            // The retry affordance is gone once the overlay hides, so drop the
            // pending failure: the hotkey reverts to starting a new recording.
            *app_inner.current_failure_ts.lock().await = None;
            set_escape_enabled_now(&app_handle, false);
            set_overlay_retry_interaction(&app_handle, false);
            if let Some(overlay) = app_handle.get_window("overlay") {
                let _ = overlay.hide();
            }
        }
    });
}

/// Directly toggle the ESC-cancel shortcut, independent of the recording state
/// machine. Used to keep ESC live while a retryable failure is shown (idle).
fn set_escape_enabled_now(app: &AppHandle, enabled: bool) {
    if let Some(hc) = app.try_state::<hotkey::HotkeyConfig>() {
        hotkey::set_escape_enabled(&hc, enabled);
    }
}

/// Native macOS overlay renderer. Builds and updates an AppKit pill
/// (`NSGlassEffectView` → container → indicator + transcript label) living inside
/// the overlay window's content view, above the transparent WebView.
#[cfg(target_os = "macos")]
mod macos;
