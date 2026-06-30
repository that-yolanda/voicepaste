//! ASR session management: engine resolution, background connect with audio
//! buffering, the transcript-forwarding event loop, and auto-reconnect.

use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::app_state::{self, set_app_state, RecordingState};
use crate::overlay;

use super::capture;
use super::cue;
use super::finalize;
use super::history;
use super::{
    current_session_text, emit_hint, is_current_epoch, is_recording, reset_matcher_recording,
};

/// Maximum number of consecutive ASR reconnect attempts before giving up and
/// finalizing the recording with whatever text was recognized so far. Reset to
/// zero each time the reconnected session produces a fresh transcript.
const MAX_ASR_RECONNECT: u32 = 3;

/// Backoff before retrying a failed ASR connection.
const RECONNECT_BACKOFF_MS: u64 = 300;

/// Resolve the configured ASR engine and open a new session. Shared by the
/// initial background connect and the reconnect path. Returns the session, its
/// event receiver, and whether the overlay should show a static "recording" hint
/// (non-streaming engines produce no partial results).
pub(super) async fn create_active_session(
    app_handle: &AppHandle,
    config: &crate::config::AppConfig,
    hotwords: &[String],
) -> Result<
    (
        Box<dyn crate::asr::AsrSession>,
        tokio::sync::mpsc::UnboundedReceiver<crate::asr::AsrEvent>,
        bool,
    ),
    String,
> {
    let resource_dir = app_handle
        .path()
        .resource_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    let data_dir = app_handle
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    let registry = crate::model::load_registry(&data_dir, &resource_dir);
    crate::asr::create_engine_session(config, &registry, data_dir, resource_dir, hotwords).await
}

/// Connect the ASR session in the background (one retry), then attach it: flush
/// any audio buffered during the connect and publish the ready session. Signals
/// completion through `connect_tx` so `stop_recording` can wait when the user
/// stops before the session is ready.
pub(super) async fn connect_and_attach(
    app_handle: AppHandle,
    config: crate::config::AppConfig,
    hotwords: Vec<String>,
    my_epoch: u64,
    connect_tx: tokio::sync::oneshot::Sender<Result<(), String>>,
) {
    let app_inner: Arc<app_state::AppInner> =
        Arc::clone(&app_handle.state::<Arc<app_state::AppInner>>());

    // If stop_recording already ended this session before we even started
    // connecting, abort early instead of establishing a WebSocket that will
    // only time out on the server side (no audio will be fed to it).
    if !is_recording(&app_handle) {
        let _ = connect_tx.send(Err("已取消".to_string()));
        return;
    }

    // Each Doubao attempt is bounded to 5s inside the engine; retry once.
    let mut result = create_active_session(&app_handle, &config, &hotwords).await;
    if result.is_err() && is_current_epoch(&app_inner, my_epoch) {
        // Check again before spending another 5 s on the retry.
        if !is_recording(&app_handle) {
            let _ = connect_tx.send(Err("已取消".to_string()));
            return;
        }
        if let Err(ref e) = result {
            log_rec!(warn, "ASR connect failed, retrying once: {}", e);
        }
        result = create_active_session(&app_handle, &config, &hotwords).await;
    }

    // A newer session (cancel / restart) superseded us: discard quietly.
    if !is_current_epoch(&app_inner, my_epoch) {
        if let Ok((session, _, _)) = result {
            session.close();
        }
        let _ = connect_tx.send(Err("已取消".to_string()));
        return;
    }

    match result {
        Ok((session, event_rx, show_recording_hint)) => {
            let session: Arc<dyn crate::asr::AsrSession> = Arc::from(session);

            // Flush buffered audio then publish the session, all under the
            // asr_session lock so send_audio_chunk cannot interleave a chunk
            // between the drain and the attach.
            {
                let mut slot = app_inner.asr_session.lock().await;
                if !is_current_epoch(&app_inner, my_epoch) {
                    session.close();
                    let _ = connect_tx.send(Err("已取消".to_string()));
                    return;
                }
                let buffered: Vec<Vec<f32>> =
                    app_inner.pending_audio.lock().await.drain(..).collect();
                for chunk in &buffered {
                    session.append_audio(chunk);
                }
                if !buffered.is_empty() {
                    log_rec!(
                        debug,
                        "Flushed {} buffered audio chunk(s) to ASR",
                        buffered.len()
                    );
                }
                *slot = Some(session);
            }

            if show_recording_hint {
                emit_hint(&app_handle, "录制中…", "info", "recording");
            }

            let app_for_events = app_handle.clone();
            // Only spawn the event manager when the recording is still active.
            // If stop_recording already ended it the session will be taken and
            // committed directly — spawning here would just produce a spurious
            // "started / error / ended" log triplet when the server times out.
            if is_recording(&app_handle) {
                tauri::async_runtime::spawn(async move {
                    manage_asr_session(app_for_events, event_rx, my_epoch).await;
                });
            }

            let _ = connect_tx.send(Ok(()));
        }
        Err(e) => {
            log_rec!(error, "ASR connection failed: {}", e);
            let _ = connect_tx.send(Err(e.clone()));

            // If the user already stopped, stop_recording owns the error UI (it
            // is awaiting connect_rx). Only handle the UI here when still
            // recording (connect failed mid-session).
            let still_recording = *app_handle.state::<RecordingState>().0.lock().unwrap();
            if !still_recording {
                return;
            }
            *app_handle.state::<RecordingState>().0.lock().unwrap() = false;
            reset_matcher_recording(&app_handle);
            app_inner.pending_audio.lock().await.clear();
            capture::stop_capture(&app_inner).await;
            history::save_recording_wav(&app_handle, &app_inner).await;
            let message = format!("ASR 连接失败: {}，请检查网络连接", e);
            history::record_transcription_failure(&app_handle, &app_inner, &message).await;
            // Emit error hint BEFORE setting idle so the overlay shows it: the
            // frontend's idle handler only clears "info"-level hints.
            overlay::emit_retryable_error_hint(&app_handle, &app_inner, &message).await;
            set_app_state(&app_handle, &app_inner, app_state::AppState::Idle).await;
            // Auto-hide after a delay so the user can read it; guard: still idle.
            overlay::schedule_retry_overlay_hide(app_handle.clone(), Arc::clone(&app_inner));
        }
    }
}

/// Manage an ASR session for the duration of a recording: forward transcripts to
/// the overlay, and on a recoverable error/close, auto-reconnect a fresh session
/// (carrying already-recognized text). On a fatal error or after reconnects are
/// exhausted, finalize the recording with the accumulated text instead of
/// discarding it.
pub(super) async fn manage_asr_session(
    app: AppHandle,
    mut event_rx: tokio::sync::mpsc::UnboundedReceiver<crate::asr::AsrEvent>,
    my_epoch: u64,
) {
    use crate::asr::AsrEvent;

    let app_inner = app.state::<Arc<app_state::AppInner>>().inner().clone();
    let mut reconnect_attempts: u32 = 0;

    log_events!(debug, "ASR session manager started (epoch {})", my_epoch);
    'outer: loop {
        while let Some(event) = event_rx.recv().await {
            match event {
                AsrEvent::Transcript {
                    final_text,
                    partial_text,
                } => {
                    // Stop feeding the overlay once this session is superseded
                    // (e.g. the user pressed ESC to abort an in-flight retry).
                    if !is_current_epoch(&app_inner, my_epoch) {
                        break 'outer;
                    }
                    // A real transcript means the (possibly reconnected) session is
                    // healthy again: reset the failure counter.
                    reconnect_attempts = 0;

                    // Save this session's transcript (without the cross-reconnect
                    // prefix) so stop_recording can fall back to it.
                    *app_inner.latest_transcript.lock().await =
                        (final_text.clone(), partial_text.clone());

                    // Prepend text accumulated from prior (disconnected) sessions
                    // so the overlay shows the complete running transcript.
                    let prefix = app_inner.accumulated_text.lock().await.clone();
                    let display_final = format!("{}{}", prefix, final_text);

                    let _ = app.emit(
                        "overlay:event",
                        serde_json::json!({
                            "type": "transcript",
                            "payload": {
                                "finalText": display_final,
                                "partialText": partial_text,
                            }
                        }),
                    );
                }
                AsrEvent::Open => {
                    log_events!(info, "ASR connection opened");
                }
                AsrEvent::Error { message, fatal } => {
                    log_events!(error, "ASR error: {} (fatal={})", message, fatal);
                    // If the user stopped/cancelled/restarted, the owning path
                    // handles finalization; don't interfere.
                    if !session_is_active(&app, &app_inner, my_epoch) {
                        break 'outer;
                    }
                    if !fatal && reconnect_attempts < MAX_ASR_RECONNECT {
                        if let Some(rx) =
                            try_reconnect_asr(&app, &app_inner, my_epoch, &mut reconnect_attempts)
                                .await
                        {
                            event_rx = rx;
                            continue 'outer;
                        }
                    }
                    finalize::finalize_on_failure(&app, &app_inner, &message).await;
                    break 'outer;
                }
                AsrEvent::Close { code, reason } => {
                    log_events!(
                        info,
                        "ASR connection closed (code={:?}, reason={:?})",
                        code,
                        reason
                    );
                    if !session_is_active(&app, &app_inner, my_epoch) {
                        break 'outer;
                    }
                    // Unexpected close mid-recording: treat as recoverable.
                    if reconnect_attempts < MAX_ASR_RECONNECT {
                        if let Some(rx) =
                            try_reconnect_asr(&app, &app_inner, my_epoch, &mut reconnect_attempts)
                                .await
                        {
                            event_rx = rx;
                            continue 'outer;
                        }
                    }
                    finalize::finalize_on_failure(&app, &app_inner, "ASR 连接已断开").await;
                    break 'outer;
                }
            }
        }
        // Event channel closed without an explicit terminal event.
        break 'outer;
    }
    log_events!(debug, "ASR session manager ended (epoch {})", my_epoch);
}

/// Attempt to rebuild the ASR session after a recoverable failure. Carries the
/// dying session's recognized text into `accumulated_text`, connects a fresh
/// session, flushes any audio buffered during the reconnect gap, and swaps it
/// into shared state so audio routing resumes automatically. Returns the new
/// event receiver on success, or `None` if the recording ended or the reconnect
/// failed.
async fn try_reconnect_asr(
    app: &AppHandle,
    app_inner: &Arc<app_state::AppInner>,
    my_epoch: u64,
    attempts: &mut u32,
) -> Option<tokio::sync::mpsc::UnboundedReceiver<crate::asr::AsrEvent>> {
    *attempts += 1;
    log_events!(
        warn,
        "ASR reconnecting (attempt {}/{})",
        attempts,
        MAX_ASR_RECONNECT
    );
    emit_hint(app, "网络中断，正在重连…", "warn", "text");

    // Play the end cue on the first reconnect attempt so the user audibly knows
    // recording was interrupted and can stop talking until they hear it resume.
    if *attempts == 1 {
        cue::emit_cue(app, app_inner, "end");
    }

    // Carry the dying session's recognized text into the accumulated prefix, and
    // clear the session slot so chunks spoken during the gap buffer into
    // pending_audio (drained into the new session below).
    let carry = current_session_text(app_inner).await;
    if let Some(old) = app_inner.asr_session.lock().await.take() {
        old.close();
    }
    if !carry.is_empty() {
        app_inner.accumulated_text.lock().await.push_str(&carry);
    }
    *app_inner.latest_transcript.lock().await = (String::new(), String::new());

    // Small backoff before retrying.
    tokio::time::sleep(Duration::from_millis(RECONNECT_BACKOFF_MS)).await;

    if !session_is_active(app, app_inner, my_epoch) {
        return None;
    }

    let config = match app_inner.config_manager.load_config() {
        Ok(c) => c,
        Err(e) => {
            log_events!(error, "Reconnect aborted, config load failed: {}", e);
            return None;
        }
    };
    let hotwords = app_inner.hotword_manager.active_words();

    match create_active_session(app, &config, &hotwords).await {
        Ok((session, event_rx, _)) => {
            let session: Arc<dyn crate::asr::AsrSession> = Arc::from(session);
            // Flush audio buffered during the gap, then publish, under the
            // asr_session lock so send_audio_chunk cannot interleave.
            {
                let mut slot = app_inner.asr_session.lock().await;
                if !session_is_active(app, app_inner, my_epoch) {
                    session.close();
                    return None;
                }
                let buffered: Vec<Vec<f32>> =
                    app_inner.pending_audio.lock().await.drain(..).collect();
                for chunk in &buffered {
                    session.append_audio(chunk);
                }
                if !buffered.is_empty() {
                    log_events!(
                        debug,
                        "Flushed {} buffered chunk(s) after reconnect",
                        buffered.len()
                    );
                }
                *slot = Some(session);
            }
            log_events!(info, "ASR reconnected successfully");
            emit_hint(app, "已重连", "info", "text");
            // Play the start cue so the user audibly knows recording resumed.
            cue::emit_cue(app, app_inner, "start");
            Some(event_rx)
        }
        Err(e) => {
            log_events!(error, "ASR reconnect failed: {}", e);
            None
        }
    }
}

/// True while this manager's recording session is still the active, current one
/// (not stopped, cancelled, or superseded by a restart).
fn session_is_active(app: &AppHandle, app_inner: &app_state::AppInner, my_epoch: u64) -> bool {
    is_recording(app) && is_current_epoch(app_inner, my_epoch)
}
