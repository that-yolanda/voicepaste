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

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::{App, AppHandle, Emitter, Manager};

use crate::app_state;
use crate::hotkey;

// Updated only on the main thread; a later show invalidates pending hide completions.
static VISIBILITY_GENERATION: AtomicU64 = AtomicU64::new(0);

pub(crate) fn show(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let generation = VISIBILITY_GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
        #[cfg(target_os = "macos")]
        macos::animate_visibility(&handle, true);
        #[cfg(not(target_os = "macos"))]
        let _ = handle.emit(
            "overlay:event",
            serde_json::json!({
                "type": "visibility", "payload": { "visible": true, "generation": generation }
            }),
        );
        #[cfg(target_os = "macos")]
        let _ = generation;
        if let Some(window) = handle.get_window("overlay") {
            let _ = window.show();
        }
    });
}

pub(crate) fn hide(app: &AppHandle) {
    let expected = app.try_state::<Arc<app_state::AppInner>>().map(|inner| {
        invalidate_feedback(&inner);
        inner.overlay_epoch.load(Ordering::SeqCst)
    });
    hide_for_epoch(app, expected);
}

fn hide_for_epoch(app: &AppHandle, expected: Option<u64>) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(inner) = handle.try_state::<Arc<app_state::AppInner>>() {
            if let Some(epoch) = expected {
                if inner.overlay_epoch.load(Ordering::SeqCst) != epoch {
                    return;
                }
            }
            invalidate_feedback(&inner);
        }
        emit_shortcuts(&handle, &[]);
        let generation = VISIBILITY_GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
        #[cfg(target_os = "macos")]
        macos::animate_visibility(&handle, false);
        #[cfg(not(target_os = "macos"))]
        let _ = handle.emit(
            "overlay:event",
            serde_json::json!({
                "type": "visibility", "payload": { "visible": false, "generation": generation }
            }),
        );
        tauri::async_runtime::spawn(async move {
            // Native animations run immediately. The WebView acknowledges completion;
            // its timeout also handles a renderer that has not loaded or stopped responding.
            let delay = if cfg!(target_os = "macos") { 120 } else { 500 };
            tokio::time::sleep(Duration::from_millis(delay)).await;
            complete_hide(&handle, generation);
        });
    });
}

pub(crate) fn complete_hide(app: &AppHandle, generation: u64) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if VISIBILITY_GENERATION.load(Ordering::Relaxed) == generation {
            if let Some(window) = handle.get_window("overlay") {
                let _ = window.hide();
            }
        }
    });
}

/// Forward an `overlay:event` to the native macOS renderer. No-op elsewhere.
#[allow(unused_variables)]
pub fn handle_event(app: &AppHandle, event: &serde_json::Value) {
    #[cfg(target_os = "macos")]
    macos::dispatch(app, event);
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

pub(crate) fn invalidate_feedback(inner: &app_state::AppInner) {
    inner.overlay_epoch.fetch_add(1, Ordering::SeqCst);
    inner.feedback_visible.store(false, Ordering::SeqCst);
}

pub(crate) fn emit_shortcuts(app: &AppHandle, shortcuts: &[shared::Shortcut]) {
    let _ = app.emit(
        "overlay:event",
        serde_json::json!({
            "type": "shortcuts", "payload": { "shortcuts": shortcuts }
        }),
    );
}

pub(crate) async fn begin_recording_hints(_app: &AppHandle, inner: &app_state::AppInner) {
    let config = inner.config_manager.load_config().ok();
    let toggle = *inner.recording_mode.lock().await == hotkey::HotkeyMode::Toggle;
    let all_prompts = inner.config_manager.load_prompts();
    let enabled = config
        .as_ref()
        .map(|c| hotkey::compile_bindings(&c.app, &all_prompts).0)
        .unwrap_or_default();
    let prompts: Vec<_> = all_prompts
        .into_iter()
        .filter(|p| {
            enabled
                .iter()
                .any(|b| b.prompt_id.as_deref() == Some(&p.id))
        })
        .collect();
    let hotkey = config
        .as_ref()
        .filter(|c| toggle && c.app.hotkey_mode != "hold")
        .and_then(|c| c.app.voice_hotkey.as_deref().or(c.app.hotkey.as_str()))
        .filter(|key| {
            enabled.iter().any(|b| {
                !b.wake_only
                    && b.prompt_id.is_none()
                    && Some(&b.keys) == hotkey::parse_hotkey_string(key).as_ref()
            })
        })
        .map(hotkey::format_hotkey_label)
        .unwrap_or_default();
    let selected = select_hint_prompt(
        &prompts,
        config
            .as_ref()
            .and_then(|c| c.app.last_polish_prompt_id.as_deref()),
        config.as_ref().and_then(|c| c.app.hotkey.as_str()),
    );
    let mut shortcuts = vec![shared::Shortcut::new("Esc", "取消")];
    if !hotkey.is_empty() {
        shortcuts.push(shared::Shortcut::new(hotkey, "完成"));
    }
    if let Some(prompt) = selected.filter(|_| toggle) {
        shortcuts.push(shared::Shortcut::new(
            hotkey::format_hotkey_label(&prompt.hotkey),
            &prompt.title,
        ));
    }
    *inner.recording_hints.lock().await = Some(shared::RecordingHints {
        toggle,
        shortcuts,
        last_signal: std::time::Instant::now(),
        shown: false,
    });
}

fn select_hint_prompt<'a>(
    prompts: &'a [crate::config::PromptItem],
    recent: Option<&str>,
    main_hotkey: Option<&str>,
) -> Option<&'a crate::config::PromptItem> {
    let main_keys = main_hotkey.and_then(hotkey::parse_hotkey_string);
    let eligible = |(index, p): &(usize, &crate::config::PromptItem)| {
        let Some(keys) = hotkey::parse_hotkey_string(&p.hotkey) else {
            return false;
        };
        p.hotkey_mode != "hold"
            && main_keys.as_ref() != Some(&keys)
            && !prompts[..*index]
                .iter()
                .any(|earlier| hotkey::parse_hotkey_string(&earlier.hotkey).as_ref() == Some(&keys))
    };
    let candidates = || {
        prompts
            .iter()
            .enumerate()
            .filter(eligible)
            .map(|(_, prompt)| prompt)
    };
    candidates()
        .find(|p| Some(p.id.as_str()) == recent)
        .or_else(|| candidates().next())
}

pub(crate) async fn show_restart_error(
    app: &AppHandle,
    inner: &Arc<app_state::AppInner>,
    text: &str,
) {
    app_state::set_app_state(app, inner, app_state::AppState::Idle).await;
    emit_retryable_error_hint(app, inner, text).await;
    show(app);
    schedule_retry_overlay_hide(app.clone(), Arc::clone(inner));
}

pub(crate) async fn show_output_error(
    app: &AppHandle,
    inner: &Arc<app_state::AppInner>,
    text: &str,
) {
    log_rec!(error, "Text output failed: {}", text);
    app_state::set_app_state(app, inner, app_state::AppState::Idle).await;
    invalidate_feedback(inner);
    inner.feedback_visible.store(true, Ordering::SeqCst);
    let _ = app.emit(
        "overlay:event",
        serde_json::json!({
            "type": "hint", "payload": { "text": text, "level": "error", "variant": "text" }
        }),
    );
    emit_shortcuts(app, &[shared::Shortcut::new("Esc", "取消")]);
    show(app);
    schedule_retry_overlay_hide(app.clone(), Arc::clone(inner));
}

pub(crate) async fn show_success(
    app: &AppHandle,
    inner: &Arc<app_state::AppInner>,
    keep_clipboard: bool,
) {
    app_state::set_app_state(app, inner, app_state::AppState::Idle).await;
    invalidate_feedback(inner);
    inner.feedback_visible.store(true, Ordering::SeqCst);
    emit_shortcuts(app, &[]);
    let _ = app.emit(
        "overlay:event",
        serde_json::json!({
            "type": "hint", "payload": {
                "text": if keep_clipboard { "已保存到剪切板" } else { "" },
                "level": "info", "variant": "success"
            }
        }),
    );
    show(app);
    let epoch = inner.overlay_epoch.load(Ordering::SeqCst);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(2)).await;
        hide_for_epoch(&app, Some(epoch));
    });
}

/// Legacy text-only path for domains not yet migrated to structured errors
/// (audio capture, output/paste). Goes away once those domains carry codes.
pub(crate) async fn emit_retryable_error_hint(
    app: &AppHandle,
    app_inner: &Arc<app_state::AppInner>,
    text: &str,
) {
    invalidate_feedback(app_inner);
    app_inner.feedback_visible.store(true, Ordering::SeqCst);
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
    emit_shortcuts(app, &error_shortcuts(&hotkey, false));
}

/// Emit a retryable error hint from a structured error. The payload carries
/// the full i18n key (`errors.<code>`) plus params/detail so each renderer
/// localizes it; `text` keeps a pre-rendered transition line for renderers
/// that have not migrated to the code yet.
pub(crate) async fn emit_retryable_error(
    app: &AppHandle,
    app_inner: &Arc<app_state::AppInner>,
    error: &crate::errors::AppError,
) {
    invalidate_feedback(app_inner);
    app_inner.feedback_visible.store(true, Ordering::SeqCst);
    let hotkey = hotkey::current_hotkey_label(app_inner).await;
    let mut payload = serde_json::json!({
        "text": render_error_text(app_inner, error),
        "level": "error",
        "variant": "text",
        "retryable": true,
        "hotkey": hotkey
    });
    attach_error_payload(&mut payload, error);
    let _ = app.emit(
        "overlay:event",
        serde_json::json!({ "type": "hint", "payload": payload }),
    );
    emit_shortcuts(app, &error_shortcuts(&hotkey, false));
}

/// Transition text for renderers that have not migrated to `code`: headline
/// (localized to the current UI language) plus detail, joined with a
/// language-appropriate separator.
pub(crate) fn render_error_text(
    app_inner: &Arc<app_state::AppInner>,
    error: &crate::errors::AppError,
) -> String {
    let language = *app_inner.language.read().unwrap();
    let mut headline = error.code.render_headline(language, &error.params);
    if let Some(detail) = &error.detail {
        let separator = if language == crate::lang::Language::ZhCn {
            "："
        } else {
            ": "
        };
        headline.push_str(separator);
        headline.push_str(detail);
    }
    headline
}

/// Attach the structured error fields to a hint payload: the full i18n key
/// (`errors.<code>`), interpolation params, and detail.
fn attach_error_payload(payload: &mut serde_json::Value, error: &crate::errors::AppError) {
    payload["code"] = serde_json::json!(format!("errors.{}", error.code.as_str()));
    if !error.params.is_empty() {
        payload["params"] = serde_json::to_value(&error.params).unwrap_or_default();
    }
    if let Some(detail) = &error.detail {
        payload["detail"] = serde_json::json!(detail);
    }
}

fn error_shortcuts(hotkey: &str, polish: bool) -> Vec<shared::Shortcut> {
    let mut shortcuts = Vec::new();
    if !hotkey.is_empty() {
        shortcuts.push(shared::Shortcut::new(hotkey, "重试"));
    }
    shortcuts.push(shared::Shortcut::new("Esc", "取消"));
    if polish {
        shortcuts.push(shared::Shortcut::new("Enter", "输出原文"));
    }
    shortcuts
}

/// Show a polish failure with explicit timeout wording and keyboard actions above it.
/// Carries the structured error (code/params/detail) so each renderer can
/// localize it; `text` keeps a pre-rendered transition line for renderers
/// that have not migrated to the code yet.
pub(crate) async fn emit_polish_decision_hint(
    app: &AppHandle,
    app_inner: &Arc<app_state::AppInner>,
    error: &crate::errors::AppError,
) {
    invalidate_feedback(app_inner);
    app_inner.feedback_visible.store(true, Ordering::SeqCst);
    let hotkey = hotkey::current_hotkey_label(app_inner).await;
    let mut payload = serde_json::json!({
        "text": format!("{}\n5 秒后输出原文", render_error_text(app_inner, error)),
        "level": "error",
        "variant": "text",
        "retryable": true,
        "hotkey": hotkey
    });
    attach_error_payload(&mut payload, error);
    let _ = app.emit(
        "overlay:event",
        serde_json::json!({ "type": "hint", "payload": payload }),
    );
    emit_shortcuts(app, &error_shortcuts(&hotkey, true));
}

pub(crate) fn schedule_retry_overlay_hide(
    app_handle: AppHandle,
    app_inner: Arc<app_state::AppInner>,
) {
    // While the retry is shown (idle), keep ESC live so it can dismiss the failure.
    // set_app_state(Idle) just disabled it, so re-enable it here.
    set_escape_enabled_now(&app_handle, true);
    let epoch = app_inner.overlay_epoch.load(Ordering::SeqCst);
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(5)).await;
        let still_idle = matches!(*app_inner.state.lock().await, app_state::AppState::Idle);
        if still_idle && app_inner.overlay_epoch.load(Ordering::SeqCst) == epoch {
            let mut failure = app_inner.current_failure_ts.lock().await;
            if app_inner.overlay_epoch.load(Ordering::SeqCst) != epoch {
                return;
            }
            *failure = None;
            drop(failure);
            let handle = app_handle.clone();
            let _ = app_handle.run_on_main_thread(move || {
                if app_inner.overlay_epoch.load(Ordering::SeqCst) != epoch {
                    return;
                }
                // The timer belongs to this error; a later retry/new session invalidates it.
                set_escape_enabled_now(&handle, false);
                hide_for_epoch(&handle, Some(epoch));
            });
        }
    });
}

/// Directly toggle the ESC-cancel shortcut, independent of the recording state
/// machine. Used to keep ESC live while a retryable failure or a deferred
/// polish decision is shown (idle).
pub(crate) fn set_escape_enabled_now(app: &AppHandle, enabled: bool) {
    if let Some(hc) = app.try_state::<hotkey::HotkeyConfig>() {
        hotkey::set_escape_enabled(&hc, enabled);
    }
}

/// Directly toggle the Enter confirm key. Only the polish flow uses this.
pub(crate) fn set_enter_enabled_now(app: &AppHandle, enabled: bool) {
    if let Some(hc) = app.try_state::<hotkey::HotkeyConfig>() {
        hotkey::set_enter_enabled(&hc, enabled);
    }
}

/// Hard ceiling on how long the decision keys may stay armed (the 5s window
/// plus the 90s polish-retry budget, with headroom). Every arm refreshes the
/// timestamp; if a dismissal path is ever missed, the watchdog releases the
/// keys — and with them the keytap suppression — so a bug can never leave
/// the user's Enter/ESC swallowed for good.
const DECISION_KEYS_WATCHDOG: Duration = Duration::from_secs(100);

/// When the decision keys were last armed (unix ms). Zero = not armed.
static DECISION_KEYS_ARMED_AT_MS: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

/// Toggle both decision keys (ESC + Enter) at once. The polish flow arms and
/// dismisses them as a pair so Enter is never left listening after the
/// decision window or an interrupted retry has ended.
pub(crate) fn set_decision_keys_enabled(app: &AppHandle, enabled: bool) {
    set_escape_enabled_now(app, enabled);
    set_enter_enabled_now(app, enabled);
    if enabled {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        DECISION_KEYS_ARMED_AT_MS.store(now_ms, std::sync::atomic::Ordering::Release);
        let watchdog_app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(DECISION_KEYS_WATCHDOG).await;
            // Zero (or a later arm's timestamp) means the keys were properly
            // dismissed — or re-armed, in which case that arm's own watchdog
            // owns the cleanup from here on.
            if DECISION_KEYS_ARMED_AT_MS.load(std::sync::atomic::Ordering::Acquire) != now_ms {
                return;
            }
            log_rec!(error, "Decision keys stuck armed; watchdog releasing them");
            set_decision_keys_enabled(&watchdog_app, false);
        });
    } else {
        // Mark the disarm so a pending watchdog stands down instead of
        // misreporting a healthy release as "stuck armed".
        DECISION_KEYS_ARMED_AT_MS.store(0, std::sync::atomic::Ordering::Release);
    }
}

/// Native macOS overlay renderer. Builds and updates an AppKit pill
/// (`NSGlassEffectView` → container → indicator + transcript label) living inside
/// the overlay window's content view, above the transparent WebView.
#[cfg(target_os = "macos")]
mod macos;

#[cfg(test)]
mod tests {
    use super::*;
    fn prompt(id: &str, key: &str, mode: &str) -> crate::config::PromptItem {
        serde_json::from_value(serde_json::json!({ "id": id, "hotkey": key, "hotkey_mode": mode }))
            .unwrap()
    }
    #[test]
    fn recent_hint_template_falls_back_to_first_usable_binding() {
        let prompts = vec![
            prompt("no-key", "", "toggle"),
            prompt("hold", "ControlLeft", "hold"),
            prompt("first", "F14", "toggle"),
            prompt("recent", "F15", "toggle"),
        ];
        assert_eq!(
            select_hint_prompt(&prompts, Some("recent"), Some("F13"))
                .unwrap()
                .id,
            "recent"
        );
        assert_eq!(
            select_hint_prompt(&prompts, Some("deleted"), Some("F13"))
                .unwrap()
                .id,
            "first"
        );
        assert_eq!(
            select_hint_prompt(&prompts, Some("hold"), Some("F13"))
                .unwrap()
                .id,
            "first"
        );
        assert!(select_hint_prompt(&prompts[..2], None, Some("F13")).is_none());
    }
    #[test]
    fn hint_template_cannot_claim_another_bindings_shortcut() {
        let prompts = vec![
            prompt("main-conflict", "F13", "toggle"),
            prompt("first", "F14", "toggle"),
            prompt("duplicate", "F14", "toggle"),
        ];
        assert_eq!(
            select_hint_prompt(&prompts, Some("main-conflict"), Some("F13"))
                .unwrap()
                .id,
            "first"
        );
        assert_eq!(
            select_hint_prompt(&prompts, Some("duplicate"), Some("F13"))
                .unwrap()
                .id,
            "first"
        );
    }
    #[test]
    fn error_actions_only_offer_raw_output_for_polish() {
        assert_eq!(
            error_shortcuts("Fn", false)
                .iter()
                .map(|s| s.label.as_str())
                .collect::<Vec<_>>(),
            vec!["重试", "取消"]
        );
        assert_eq!(error_shortcuts("Fn", true).last().unwrap().key, "Enter");
        assert_eq!(
            error_shortcuts("", false),
            vec![shared::Shortcut::new("Esc", "取消")]
        );
    }
}
