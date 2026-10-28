//! Recording module: hotkey-driven start/stop, ASR session management with
//! auto-reconnect, the retry pipeline, audio capture (cpal), WAV I/O, cue
//! playback, recording history, and the finalize-and-paste finishing flow.
//!
//! Submodules are private; only the entry points re-exported below are visible
//! to the rest of the crate (`crate::recording::on_*`, `::retry_*`).

mod capture;
mod cue;
mod finalize;
mod history;
mod lifecycle;
mod polish;
mod regenerate;
mod retry;
mod session;
mod wav;

use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager};

use crate::app_state::{self, ActivePromptId, RecordingState};
use crate::hotkey;

pub(crate) use capture::NativeAudioCapture;
pub(crate) use polish::repolish_history_entry;
pub(crate) use polish::retry_pending_polish;
pub(crate) use regenerate::regenerate_history_transcription;
pub(crate) use retry::{retry_history_transcription, retry_latest_failed_transcription};
pub(crate) use wav::audio_chunk_has_signal;

/// Begin a neutral recording triggered by the hotkey matcher — the prompt is
/// decided later, on stop. If the main hotkey was used while a retryable
/// failure is shown, retry that failure instead of starting a new recording.
pub(crate) async fn on_recording_start(
    app_handle: AppHandle,
    is_main: bool,
    mode: hotkey::HotkeyMode,
) {
    {
        let app_inner = app_handle.state::<Arc<app_state::AppInner>>();
        // A polish retry is in flight: ignore the press entirely. ESC/Enter are
        // the ways out of a retry; starting a recording mid-request would race
        // the retry's delivery.
        if polish::is_retry_active(&app_inner)
            || !matches!(*app_inner.state.lock().await, app_state::AppState::Idle)
        {
            log_rec!(info, "Finalization in flight; ignoring hotkey start");
            reset_matcher_recording(&app_handle);
            return;
        }
    }

    if is_main {
        let app_inner = app_handle.state::<Arc<app_state::AppInner>>();
        let idle = matches!(*app_inner.state.lock().await, app_state::AppState::Idle);

        // A failed polish is waiting on a decision: the main hotkey retries the
        // polish rather than starting a new recording. Reset the matcher FIRST:
        // in hold mode the keyup may arrive while the retry is still awaiting,
        // and a matcher that still believes it is recording would turn that
        // keyup into a stray stop (and a bogus failure entry).
        if idle && polish::has_pending_polish(&app_inner).await {
            reset_matcher_recording(&app_handle);
            polish::retry_pending_polish(app_handle.clone()).await;
            return;
        }

        let can_retry = idle && app_inner.current_failure_ts.lock().await.is_some();
        if can_retry {
            // Same stray-stop hazard as above: reset before awaiting the retry.
            reset_matcher_recording(&app_handle);
            let _ = retry::retry_latest_failed_transcription(app_handle.clone()).await;
            return;
        }
    }

    // A global wake must have a usable toggle stop. Keep retry handling above
    // available even when every feature is hold-only or its stop is disabled.
    if is_main {
        let inner = app_handle.state::<Arc<app_state::AppInner>>();
        let can_stop = inner.config_manager.load_config().is_ok_and(|config| {
            hotkey::compile_bindings(&config.app, &inner.config_manager.load_prompts())
                .0
                .iter()
                .any(|b| !b.wake_only && b.mode == hotkey::HotkeyMode::Toggle)
        });
        if !can_stop {
            reset_matcher_recording(&app_handle);
            return;
        }
    }

    let inner = app_handle.state::<Arc<app_state::AppInner>>();
    *inner.recording_mode.lock().await = mode;
    crate::overlay::invalidate_feedback(&inner);
    lifecycle::start_recording(app_handle.clone()).await;

    // If the start aborted (config/audio failure), resync the matcher so it
    // doesn't think it's still recording.
    if !is_recording(&app_handle) {
        reset_matcher_recording(&app_handle);
    }
}

/// End the active recording and finalize with the prompt resolved from the
/// stop chord. Sets ActivePromptId just before stopping so the finishing
/// pipeline knows whether to polish.
pub(crate) async fn on_recording_stop(app_handle: AppHandle, prompt_id: Option<String>) {
    {
        // Swallow stray stops born in the window between a diverted start and
        // its matcher reset: the retry that start spawned has no recording
        // session, so a stop here would tear down the overlay under it.
        let app_inner = app_handle.state::<Arc<app_state::AppInner>>();
        if polish::is_retry_active(&app_inner) {
            return;
        }
    }
    if let Some(id) = prompt_id.as_deref() {
        let inner = app_handle.state::<Arc<app_state::AppInner>>();
        if let Err(error) = inner.config_manager.remember_polish_prompt(id) {
            log_rec!(warn, "Failed to remember polish template: {}", error);
        }
    }
    if let Some(active) = app_handle.try_state::<ActivePromptId>() {
        *active.0.lock().unwrap() = prompt_id;
    }
    lifecycle::stop_recording(app_handle).await;
}

/// ESC handler. Routes to the right teardown for whatever is on screen:
/// an active recording, a polish decision window or retry, an in-flight ASR
/// retry, or a shown retryable failure.
pub(crate) async fn on_escape(app_handle: AppHandle) {
    if is_recording(&app_handle) {
        lifecycle::cancel_recording(app_handle).await;
        return;
    }
    let app_inner = app_handle.state::<Arc<app_state::AppInner>>();

    // A failed polish is waiting on a decision: ESC discards the text — nothing
    // is pasted and nothing is recorded.
    if polish::has_pending_polish(&app_inner).await {
        let app_inner = Arc::clone(&app_inner);
        polish::cancel_pending(&app_handle, &app_inner).await;
        return;
    }

    // A polish retry is in flight (state Finishing, no ASR retry marker): abort
    // the request and discard the text.
    if polish::is_retry_active(&app_inner) {
        let app_inner = Arc::clone(&app_inner);
        polish::interrupt_retry(&app_inner, app_state::PolishRetryCommand::Cancel).await;
        return;
    }

    if app_inner
        .feedback_visible
        .load(std::sync::atomic::Ordering::SeqCst)
        && app_inner.current_failure_ts.lock().await.is_none()
    {
        crate::overlay::set_decision_keys_enabled(&app_handle, false);
        crate::overlay::hide(&app_handle);
        return;
    }
    let state = app_inner.state.lock().await.clone();
    match state {
        // Both normal finalization and history replay must be cancellable.
        app_state::AppState::Finishing => {
            lifecycle::abort_retry_or_failure(&app_handle, &app_inner).await;
        }
        // Retryable failure currently shown: dismiss it.
        app_state::AppState::Idle if app_inner.current_failure_ts.lock().await.is_some() => {
            lifecycle::abort_retry_or_failure(&app_handle, &app_inner).await;
        }
        _ => {}
    }
}

/// Enter handler. Enter is only routed while the polish flow enables the key:
/// on the decision window it pastes the raw text immediately, and during a
/// polish retry it aborts the request and pastes the raw text.
pub(crate) async fn on_enter(app_handle: AppHandle) {
    if is_recording(&app_handle) {
        return;
    }
    let app_inner = app_handle.state::<Arc<app_state::AppInner>>();

    if polish::has_pending_polish(&app_inner).await {
        let app_inner = Arc::clone(&app_inner);
        polish::deliver_raw(&app_handle, &app_inner, "confirmed with Enter").await;
        return;
    }

    if polish::is_retry_active(&app_inner) {
        let app_inner = Arc::clone(&app_inner);
        polish::interrupt_retry(&app_inner, app_state::PolishRetryCommand::DeliverRaw).await;
    }
}

// ---------------------------------------------------------------------------
// Shared helpers (visible to submodules via `super::`)
// ---------------------------------------------------------------------------

/// Emit a typed overlay hint event. Centralizes the recurring `overlay:event`
/// JSON shape used across the lifecycle, session, retry, and finalize paths.
pub(super) fn emit_hint(app: &AppHandle, text: &str, level: &str, variant: &str) {
    let _ = app.emit(
        "overlay:event",
        serde_json::json!({
            "type": "hint",
            "payload": { "text": text, "level": level, "variant": variant }
        }),
    );
}

/// Emit a hint carrying a full i18n key (plus interpolation params) so each
/// renderer localizes it locally. `code` is the locale key (`ui.overlay.*` or
/// `errors.*`).
pub(super) fn emit_hint_key(
    app: &AppHandle,
    code: &str,
    params: std::collections::BTreeMap<String, String>,
    level: &str,
    variant: &str,
) {
    let _ = app.emit(
        "overlay:event",
        serde_json::json!({
            "type": "hint",
            "payload": {
                "text": "",
                "code": code,
                "params": params,
                "level": level,
                "variant": variant
            }
        }),
    );
}

/// Reset matching after cancellation, diverted starts, or failed preparation.
pub(super) fn reset_matcher_recording(app_handle: &AppHandle) {
    if let Some(hc) = app_handle.try_state::<hotkey::HotkeyConfig>() {
        hotkey::reset_recording(&hc);
    }
}

/// Read the current recording flag without holding the lock across await points.
pub(super) fn is_recording(app: &AppHandle) -> bool {
    app.try_state::<RecordingState>()
        .map(|state| *state.0.lock().unwrap())
        .unwrap_or(false)
}

/// True while `my_epoch` is still the current recording session. A background
/// connect task uses this to detect that a cancel/restart has superseded it.
pub(super) fn is_current_epoch(app_inner: &app_state::AppInner, my_epoch: u64) -> bool {
    app_inner
        .session_epoch
        .load(std::sync::atomic::Ordering::SeqCst)
        == my_epoch
}

/// Snapshot the best text recognized in the current session from shared state.
/// `manage_asr_session` stores every transcript here, so it serves as the
/// confirmed-only carry-over source across a reconnect. Temporary text is
/// never promoted to final text, including on errors.
pub(super) async fn current_session_text(app_inner: &app_state::AppInner) -> String {
    app_inner.latest_transcript.lock().await.0.clone()
}
