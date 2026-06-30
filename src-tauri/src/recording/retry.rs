//! Retry pipeline: re-transcribe a stored history recording through a fresh
//! ASR session, surfacing failures as retryable overlay hints.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

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

/// Delay before pasting a retried transcription so the OS has time to hand
/// focus back to the window the user was in.
const FOCUS_RESTORE_DELAY_MS: u64 = 150;

pub(crate) async fn retry_history_transcription(
    app_handle: AppHandle,
    ts: String,
) -> Result<serde_json::Value, String> {
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
    message: &str,
) {
    let failure_ts = app_inner.stats.lock().await.record_failure(
        message,
        history::current_recording_wav_string(app_inner).await,
        Some(ts.to_string()),
    );
    *app_inner.current_failure_ts.lock().await = Some(failure_ts);
    overlay::emit_retryable_error_hint(app_handle, app_inner, message).await;
    overlay::set_overlay_retry_interaction(app_handle, true);
    set_app_state(app_handle, app_inner, app_state::AppState::Idle).await;
    overlay::schedule_retry_overlay_hide(app_handle.clone(), Arc::clone(app_inner));
}

async fn retry_history_transcription_inner(
    app_handle: AppHandle,
    ts: String,
    retry_epoch: u64,
) -> Result<serde_json::Value, String> {
    let app_inner = app_handle.state::<Arc<app_state::AppInner>>();
    let entry = {
        let stats = app_inner.stats.lock().await;
        stats
            .find_history(&ts)
            .ok_or_else(|| "未找到输入记录".to_string())?
    };
    let audio_path = entry
        .audio_path
        .clone()
        .ok_or_else(|| "这条记录没有可重试的录音".to_string())?;
    let path = PathBuf::from(&audio_path);
    let samples = wav::read_wav_16k_mono(&path)?;
    if samples.is_empty() {
        return Err("录音文件为空，无法重试".to_string());
    }

    overlay::set_overlay_retry_interaction(&app_handle, false);
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

    let config = app_inner.config_manager.load_config()?;
    let hotwords = app_inner.hotword_manager.active_words();
    let (session, event_rx, _) =
        match session::create_active_session(&app_handle, &config, &hotwords).await {
            Ok(result) => result,
            Err(error) => {
                if !is_current_epoch(&app_inner, retry_epoch) {
                    return Err("重试已取消".to_string());
                }
                let message = format!("{error}，请检查网络连接");
                fail_retry(&app_handle, &app_inner, &ts, &message).await;
                return Err(message);
            }
        };
    let session: Arc<dyn crate::asr::AsrSession> = Arc::from(session);
    if !is_current_epoch(&app_inner, retry_epoch) {
        session.close();
        return Err("重试已取消".to_string());
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
                return Err("重试已取消".to_string());
            }
            session.close();
            let message = "重试转写没有得到文本，请检查网络连接";
            fail_retry(&app_handle, &app_inner, &ts, message).await;
            return Err(message.to_string());
        }
        Err(error) => {
            if !is_current_epoch(&app_inner, retry_epoch) {
                session.close();
                return Err("重试已取消".to_string());
            }
            session.close();
            let error = format!("{error}，请检查网络连接");
            fail_retry(&app_handle, &app_inner, &ts, &error).await;
            return Err(error);
        }
    };

    if !is_current_epoch(&app_inner, retry_epoch) {
        session.close();
        return Err("重试已取消".to_string());
    }
    // Hand focus back to the app the user was in before clicking retry, then give
    // the OS a moment to switch, so the paste keystroke lands in the right window.
    overlay::restore_foreground_app(&app_handle);
    tokio::time::sleep(Duration::from_millis(FOCUS_RESTORE_DELAY_MS)).await;
    finalize::finalize_and_paste(&app_handle, &app_inner, text.clone()).await;
    session.close();
    *app_inner.current_failure_ts.lock().await = None;
    set_app_state(&app_handle, &app_inner, app_state::AppState::Idle).await;
    if let Some(overlay) = app_handle.get_window("overlay") {
        let _ = overlay.hide();
    }
    Ok(serde_json::json!({ "ok": true, "text": text }))
}

pub(crate) async fn retry_latest_failed_transcription(
    app_handle: AppHandle,
) -> Result<serde_json::Value, String> {
    let app_inner = app_handle.state::<Arc<app_state::AppInner>>();
    let ts = app_inner
        .current_failure_ts
        .lock()
        .await
        .clone()
        .ok_or_else(|| "没有可重试的失败录音".to_string())?;
    retry_history_transcription(app_handle, ts).await
}
