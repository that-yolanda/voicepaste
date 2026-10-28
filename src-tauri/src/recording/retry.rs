//! Retry pipeline: re-transcribe a stored history recording through a fresh
//! ASR session, surfacing failures as retryable overlay hints.

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager};

use crate::app_state::{self, set_app_state};
use crate::overlay;

use super::finalize;
use super::history;
use super::session;
use super::wav;
use super::{emit_hint, is_current_epoch};

/// PCM chunk size (samples) fed to the ASR session when replaying a stored
/// recording. Matches the live capture chunk size.
const RETRY_CHUNK_SIZE: usize = 1600;

pub(crate) async fn retry_history_transcription(
    app_handle: AppHandle,
    ts: String,
) -> Result<serde_json::Value, crate::errors::AppError> {
    let app_inner = app_handle.state::<Arc<app_state::AppInner>>();
    let retry_epoch = app_inner
        .session_epoch
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        + 1;
    // No outer wall-clock timeout: the connection phase is already bounded by the
    // ASR connect timeout (5s, surfaced as a failure + retry), and the final wait
    // by commit_and_await_final's own timeout. An outer cap would only risk
    // cutting off a valid streaming transcription mid-flight.
    retry_history_transcription_inner(app_handle, ts, retry_epoch).await
}

/// Record a retry attempt as a failure, surface the error hint, and arm the
/// overlay retry affordance + auto-hide. Shared by every failure path of
/// `retry_history_transcription_inner`.
async fn fail_retry(
    app_handle: &AppHandle,
    app_inner: &Arc<app_state::AppInner>,
    ts: &str,
    error: &crate::errors::AppError,
    retry_epoch: u64,
) {
    if !is_current_epoch(app_inner, retry_epoch) {
        return;
    }
    {
        let mut slot = app_inner.asr_session.lock().await;
        if !is_current_epoch(app_inner, retry_epoch) {
            return;
        }
        if let Some(session) = slot.take() {
            session.close();
        }
    }
    let failure_ts = app_inner.stats.lock().await.record_failure(
        &crate::overlay::render_error_text(app_inner, error),
        history::current_recording_wav_string(app_inner).await,
        Some(ts.to_string()),
        Some(error),
    );
    if !is_current_epoch(app_inner, retry_epoch) {
        return;
    }
    *app_inner.current_failure_ts.lock().await = Some(failure_ts);
    overlay::emit_retryable_error(app_handle, app_inner, error).await;
    set_app_state(app_handle, app_inner, app_state::AppState::Idle).await;
    overlay::schedule_retry_overlay_hide(app_handle.clone(), Arc::clone(app_inner));
}

async fn retry_history_transcription_inner(
    app_handle: AppHandle,
    ts: String,
    retry_epoch: u64,
) -> Result<serde_json::Value, crate::errors::AppError> {
    use crate::errors::{AppError, AppErrorCode};

    let cancelled = || AppError::new(AppErrorCode::Cancelled);
    let app_inner = app_handle.state::<Arc<app_state::AppInner>>();
    let entry = {
        let stats = app_inner.stats.lock().await;
        stats
            .find_history(&ts)
            .ok_or_else(|| AppError::new(AppErrorCode::StatsEntryNotFound))?
    };
    let audio_path = entry
        .audio_path
        .clone()
        .ok_or_else(|| AppError::new(AppErrorCode::StatsNoRetryableRecording))?;
    let path = PathBuf::from(&audio_path);
    let samples = wav::read_wav_16k_mono(&path)?;
    if samples.is_empty() {
        return Err(AppError::new(AppErrorCode::StatsEmptyRecording));
    }

    set_app_state(&app_handle, &app_inner, app_state::AppState::Finishing).await;
    // Clear the stale failure hint + old transcript, then show a "retrying"
    // placeholder while the connection is established. The overlay yields this
    // placeholder to the live transcript the moment the replayed recognition
    // starts streaming in (see visible_hint / getVisibleHintText), so the user
    // sees "重试中" → streaming text, like a normal recording.
    let _ = app_handle.emit("overlay:event", serde_json::json!({ "type": "reset" }));
    emit_hint(&app_handle, "", "info", "retry");
    *app_inner.latest_transcript.lock().await = (String::new(), String::new());
    *app_inner.current_recording_wav.lock().await = Some(path);
    *app_inner.current_retry_of.lock().await = Some(ts.clone());

    let config = app_inner
        .config_manager
        .load_config()
        .map_err(|_| AppError::new(AppErrorCode::InvalidConfig))?;
    let hotwords = app_inner.hotword_manager.active_words();
    let (session, event_rx, _) =
        match session::create_active_session(&app_handle, &config, &hotwords).await {
            Ok(result) => result,
            Err(error) => {
                if !is_current_epoch(&app_inner, retry_epoch) {
                    return Err(cancelled());
                }
                fail_retry(&app_handle, &app_inner, &ts, &error, retry_epoch).await;
                return Err(error);
            }
        };
    let session: Arc<dyn crate::asr::AsrSession> = Arc::from(session);
    if !is_current_epoch(&app_inner, retry_epoch) {
        session.close();
        return Err(cancelled());
    }
    {
        let mut slot = app_inner.asr_session.lock().await;
        if !is_current_epoch(&app_inner, retry_epoch) {
            session.close();
            return Err(cancelled());
        }
        *slot = Some(Arc::clone(&session));
    }
    let events_app = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        session::manage_asr_session(events_app, event_rx, retry_epoch).await;
    });

    for chunk in samples.chunks(RETRY_CHUNK_SIZE) {
        session.append_audio(chunk);
    }

    let text = match session.commit_and_await_final().await {
        Ok(text) if !text.trim().is_empty() => text,
        Ok(_) => {
            if !is_current_epoch(&app_inner, retry_epoch) {
                session.close();
                return Err(cancelled());
            }
            session.close();
            let error = AppError::new(AppErrorCode::AsrEmptyResult);
            fail_retry(&app_handle, &app_inner, &ts, &error, retry_epoch).await;
            return Err(error);
        }
        Err(error) => {
            if !is_current_epoch(&app_inner, retry_epoch) {
                session.close();
                return Err(cancelled());
            }
            session.close();
            fail_retry(&app_handle, &app_inner, &ts, &error, retry_epoch).await;
            return Err(error);
        }
    };

    if !is_current_epoch(&app_inner, retry_epoch) {
        session.close();
        return Err(cancelled());
    }
    session.close();
    {
        let mut slot = app_inner.asr_session.lock().await;
        if !is_current_epoch(&app_inner, retry_epoch) {
            return Err(cancelled());
        }
        slot.take();
    }
    let outcome =
        finalize::finalize_and_paste(&app_handle, &app_inner, text.clone(), retry_epoch).await;
    if !is_current_epoch(&app_inner, retry_epoch) {
        return Err(cancelled());
    }
    *app_inner.current_failure_ts.lock().await = None;
    if outcome != finalize::FinalizeOutcome::Deferred
        && !app_inner
            .feedback_visible
            .load(std::sync::atomic::Ordering::SeqCst)
    {
        set_app_state(&app_handle, &app_inner, app_state::AppState::Idle).await;
        overlay::hide(&app_handle);
    }
    Ok(serde_json::json!({ "ok": true, "text": text }))
}

pub(crate) async fn retry_latest_failed_transcription(
    app_handle: AppHandle,
) -> Result<serde_json::Value, crate::errors::AppError> {
    let app_inner = app_handle.state::<Arc<app_state::AppInner>>();
    let ts = app_inner
        .current_failure_ts
        .lock()
        .await
        .clone()
        .ok_or_else(|| {
            crate::errors::AppError::new(crate::errors::AppErrorCode::StatsNoRetryableRecording)
        })?;
    retry_history_transcription(app_handle, ts).await
}
