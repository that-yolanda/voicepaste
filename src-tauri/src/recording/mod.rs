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
mod retry;
mod session;
mod wav;

use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager};

use crate::app_state::{self, ActivePromptId, RecordingState};
use crate::hotkey;

pub(crate) use capture::NativeAudioCapture;
pub(crate) use retry::{retry_history_transcription, retry_latest_failed_transcription};

/// Begin a neutral recording triggered by the hotkey matcher — the prompt is
/// decided later, on stop. If the main hotkey was used while a retryable
/// failure is shown, retry that failure instead of starting a new recording.
pub(crate) async fn on_recording_start(app_handle: AppHandle, is_main: bool) {
    if is_main {
        let app_inner = app_handle.state::<Arc<app_state::AppInner>>();
        let can_retry = matches!(*app_inner.state.lock().await, app_state::AppState::Idle)
            && app_inner.current_failure_ts.lock().await.is_some();
        if can_retry {
            let _ = retry::retry_latest_failed_transcription(app_handle.clone()).await;
            // Retry did not start a recording — resync the matcher so it does
            // not believe one is active.
            reset_matcher_recording(&app_handle);
            return;
        }
    }

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
    if let Some(active) = app_handle.try_state::<ActivePromptId>() {
        *active.0.lock().unwrap() = prompt_id;
    }
    lifecycle::stop_recording(app_handle).await;
}

/// ESC handler. Routes to the right teardown for whatever is on screen:
/// an active recording, an in-flight retry, or a shown retryable failure.
pub(crate) async fn on_escape(app_handle: AppHandle) {
    if is_recording(&app_handle) {
        lifecycle::cancel_recording(app_handle).await;
        return;
    }
    let app_inner = app_handle.state::<Arc<app_state::AppInner>>();
    let state = app_inner.state.lock().await.clone();
    match state {
        // Retry in progress (a normal commit has no retry marker): abort it.
        app_state::AppState::Finishing if app_inner.current_retry_of.lock().await.is_some() => {
            lifecycle::abort_retry_or_failure(&app_handle, &app_inner).await;
        }
        // Retryable failure currently shown: dismiss it.
        app_state::AppState::Idle if app_inner.current_failure_ts.lock().await.is_some() => {
            lifecycle::abort_retry_or_failure(&app_handle, &app_inner).await;
        }
        _ => {}
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

/// Reset the hotkey matcher's recording tracking, e.g. after a recording is
/// cancelled or a start is diverted to retry / fails. No-op if the hotkey
/// state isn't managed yet.
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
/// carry-over source across a reconnect and the salvage source on failure.
pub(super) async fn current_session_text(app_inner: &app_state::AppInner) -> String {
    let (final_t, partial_t) = app_inner.latest_transcript.lock().await.clone();
    if !final_t.is_empty() {
        final_t
    } else {
        partial_t
    }
}
