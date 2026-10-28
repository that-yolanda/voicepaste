//! Recording lifecycle: start, stop, cancel, and retry/failure abort paths.

use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::app_state::{self, set_app_state, ActivePromptId, RecordingState};
use crate::errors::{AppError, AppErrorCode};
use crate::overlay;

use super::capture;
use super::cue;
use super::finalize;
use super::history;
use super::session;
use super::wav;
use super::{is_current_epoch, reset_matcher_recording};

/// Start recording from idle state. Used by both toggle and hold modes.
pub(super) async fn start_recording(app_handle: AppHandle) {
    let app_inner = app_handle.state::<Arc<app_state::AppInner>>();
    let recording_state = app_handle.state::<RecordingState>();

    // Mark as recording
    *recording_state.0.lock().unwrap() = true;

    // 1. Load config
    let config = match app_inner.config_manager.load_config() {
        Ok(c) => c,
        Err(e) => {
            *recording_state.0.lock().unwrap() = false;
            log_rec!(error, "Failed to load config: {}", e);
            overlay::show_restart_error(&app_handle, &app_inner, &format!("配置加载失败: {}", e))
                .await;
            return;
        }
    };

    // Prompt-specific LLM validation is deferred to finalize_and_paste: the
    // prompt is resolved from the stop chord (not known at start), and a bad
    // LLM config surfaces there with the provider's own reason plus a retry.

    let appearance_language = *app_inner.language.read().unwrap();
    let _ = app_handle.emit("overlay:event", serde_json::json!({
        "type": "appearance", "payload": { "theme": config.app.theme, "overlayStyle": config.app.overlay_style, "language": appearance_language.code() }
    }));

    // Settle any parked polish before recording again. Otherwise its auto-paste
    // timer would fire mid-recording and drop the previous transcript into
    // whatever now has focus.
    super::polish::deliver_raw(&app_handle, &app_inner, "superseded by a new recording").await;

    *app_inner.latest_transcript.lock().await = (String::new(), String::new());
    app_inner.recording_audio.lock().await.clear();
    *app_inner.current_recording_wav.lock().await = None;
    *app_inner.current_retry_of.lock().await = None;
    *app_inner.current_failure_ts.lock().await = None;
    let _ = app_handle.emit("overlay:event", serde_json::json!({ "type": "reset" }));
    // Re-position before showing so the overlay follows the current display layout
    // (e.g. after an external monitor was connected/disconnected).
    overlay::position_overlay(&app_handle);
    overlay::show(&app_handle);

    // 2. Warm up microphone capture (native cpal on macOS + Windows). The capture
    //    owns its own ready signal (a oneshot the input thread fires once the
    //    stream is built), so there is no renderer warmup round-trip to wait on.
    set_app_state(&app_handle, &app_inner, app_state::AppState::Connecting).await;
    if let Err(e) = capture::start_capture(app_handle.clone(), Arc::clone(&app_inner)).await {
        *recording_state.0.lock().unwrap() = false;
        set_app_state(&app_handle, &app_inner, app_state::AppState::Idle).await;
        log_rec!(warn, "Native audio warmup failed: {}", e);
        reset_matcher_recording(&app_handle);
        overlay::show_restart_error(&app_handle, &app_inner, &e).await;
        return;
    }

    // Check if recording was cancelled during warmup (hold mode: quick press-release)
    if !*recording_state.0.lock().unwrap() {
        log_rec!(warn, "Cancelled during warmup, aborting start");
        capture::stop_capture(&app_inner).await;
        set_app_state(&app_handle, &app_inner, app_state::AppState::Idle).await;
        overlay::hide(&app_handle);
        return;
    }

    // 3. Active hotwords for this session (also reused on reconnect).
    let hotwords = app_inner.hotword_manager.active_words();
    log_rec!(
        debug,
        "Active hotwords ({}): {:?}",
        hotwords.len(),
        hotwords
    );

    // 4. Play the start cue and enter Recording back-to-back: the cue tells the user
    //    they may speak, so streaming must begin the instant it plays — no gap. DSP
    //    has already converged during the settle delay above. The ASR session
    //    connects in the background so the user can speak as soon as the (local,
    //    fast) mic is ready instead of waiting on the (remote, variable) network
    //    handshake; audio captured before the session is ready is buffered and
    //    flushed once it connects.
    let my_epoch = app_inner
        .session_epoch
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        + 1;
    app_inner.pending_audio.lock().await.clear();
    *app_inner.asr_session.lock().await = None;
    *app_inner.accumulated_text.lock().await = String::new();

    let (connect_tx, connect_rx) =
        tokio::sync::oneshot::channel::<Result<(), crate::errors::AppError>>();
    *app_inner.connect_rx.lock().await = Some(connect_rx);

    cue::emit_cue(&app_handle, &app_inner, "start");
    set_app_state(&app_handle, &app_inner, app_state::AppState::Recording).await;

    overlay::begin_recording_hints(&app_handle, &app_inner).await;

    // 5. Connect the ASR session in the background; attach it once ready.
    let connect_handle = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        session::connect_and_attach(connect_handle, config, hotwords, my_epoch, connect_tx).await;
    });
}

/// Stop recording and finalize (paste text). Used by both toggle and hold modes.
pub(super) async fn stop_recording(app_handle: AppHandle) {
    let app_inner = app_handle.state::<Arc<app_state::AppInner>>();
    let recording_state = app_handle.state::<RecordingState>();

    // Claim this recording exactly once before any await.
    {
        let mut recording = recording_state.0.lock().unwrap();
        if !*recording {
            return;
        }
        *recording = false;
    }
    let my_epoch = app_inner
        .session_epoch
        .load(std::sync::atomic::Ordering::SeqCst);
    let server_final_only = app_inner
        .config_manager
        .load_config()
        .is_ok_and(|config| config.audio_provider() == crate::config::ELEVENLABS_REALTIME_ID);

    // 1. Set state to finishing
    set_app_state(&app_handle, &app_inner, app_state::AppState::Finishing).await;

    // 2. Stop renderer audio first so the final buffered chunk is flushed.
    capture::stop_capture(&app_inner).await;
    if !is_current_epoch(&app_inner, my_epoch) {
        return;
    }
    // Snapshot whether real sound was captured before save_recording_wav drains
    // the buffer: a silent stop ends immediately, but speech whose transcript was
    // lost (slow/failed network) must keep the retry path even with no result yet.
    let captured_audio_signal = {
        let audio = app_inner.recording_audio.lock().await;
        wav::recording_has_audio_signal(&audio)
    };
    history::save_recording_wav(&app_handle, &app_inner).await;
    if !is_current_epoch(&app_inner, my_epoch) {
        return;
    }

    // 3. Acquire the ready ASR session. If the background connect hasn't finished
    //    (user stopped before it was ready), wait for it to resolve so the buffered
    //    audio still gets transcribed instead of being thrown away.
    let mut connection_error = None;
    let session = match app_inner.asr_session.lock().await.clone() {
        Some(s) => Some(s),
        None => {
            // If the recording was too short to contain speech and nothing was
            // recognized, cancel the in-flight connect rather than waiting up to
            // 12 s for a session that will only time out on the server side.
            // Genuine speech (signal present) still waits so the buffered audio
            // gets transcribed instead of being thrown away.
            if !server_final_only && !captured_audio_signal {
                let prefix = app_inner.accumulated_text.lock().await.clone();
                if prefix.trim().is_empty() {
                    log_rec!(
                        info,
                        "Stop with no speech signal; cancelling in-flight connect"
                    );
                    app_inner
                        .session_epoch
                        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    app_inner.pending_audio.lock().await.clear();
                    history::discard_recording_artifacts(&app_inner).await;
                    overlay::hide(&app_handle);
                    set_app_state(&app_handle, &app_inner, app_state::AppState::Idle).await;
                    return;
                }
            }
            let rx = app_inner.connect_rx.lock().await.take();
            match rx {
                Some(rx) => match tokio::time::timeout(Duration::from_secs(12), rx).await {
                    Ok(Ok(Ok(()))) => app_inner.asr_session.lock().await.clone(),
                    Ok(Ok(Err(error))) => {
                        connection_error = Some(error);
                        None
                    }
                    Ok(Err(_)) => {
                        connection_error = Some(AppError::new(AppErrorCode::AsrConnectTaskEnded));
                        None
                    }
                    Err(_) => {
                        connection_error = Some(AppError::new(AppErrorCode::AsrConnectTimeoutHint));
                        None
                    }
                },
                None => None,
            }
        }
    };
    *app_inner.asr_events.lock().await = None;

    if let Some(session) = session {
        // 4. No speech case: the session connected but produced no transcript
        //    (no partial/final this session, nothing accumulated across reconnects)
        //    AND the captured audio was silent. The user stopped without speaking;
        //    Doubao won't emit a final for silence, so committing would block until
        //    the timeout and then wrongly offer a retry. End immediately, ESC-like.
        //    If audio WAS captured but no transcript arrived (slow/failed network),
        //    fall through to commit so the result — or a retry — is still possible.
        let recognized_anything = {
            let (final_t, partial_t) = app_inner.latest_transcript.lock().await.clone();
            let accumulated = app_inner.accumulated_text.lock().await.clone();
            !final_t.trim().is_empty()
                || !partial_t.trim().is_empty()
                || !accumulated.trim().is_empty()
        };
        if !server_final_only && !recognized_anything && !captured_audio_signal {
            log_rec!(info, "Stop with no recognized speech; ending immediately");
            session.close();
            app_inner.pending_audio.lock().await.clear();
            *app_inner.accumulated_text.lock().await = String::new();
            history::discard_recording_artifacts(&app_inner).await;
            overlay::hide(&app_handle);
            set_app_state(&app_handle, &app_inner, app_state::AppState::Idle).await;
            return;
        }

        if !is_current_epoch(&app_inner, my_epoch) {
            session.close();
            return;
        }
        // 5. Commit and get this session's final text.
        let session_text = match session.commit_and_await_final().await {
            Ok(t) => t,
            Err(e) => {
                if !is_current_epoch(&app_inner, my_epoch) {
                    session.close();
                    return;
                }
                log_rec!(warn, "ASR commit failed: {}", e);
                session.close();
                {
                    let mut slot = app_inner.asr_session.lock().await;
                    if !is_current_epoch(&app_inner, my_epoch) {
                        return;
                    }
                    slot.take();
                }
                app_inner.pending_audio.lock().await.clear();
                *app_inner.accumulated_text.lock().await = String::new();
                history::record_transcription_failure(&app_handle, &app_inner, &e).await;
                if !is_current_epoch(&app_inner, my_epoch) {
                    return;
                }
                overlay::emit_retryable_error(&app_handle, &app_inner, &e).await;
                set_app_state(&app_handle, &app_inner, app_state::AppState::Idle).await;
                overlay::schedule_retry_overlay_hide(app_handle.clone(), Arc::clone(&app_inner));
                return;
            }
        };
        if !is_current_epoch(&app_inner, my_epoch) {
            session.close();
            return;
        }
        log_rec!(
            debug,
            "ASR commit final text ({} chars): {:?}",
            session_text.chars().count(),
            session_text.chars().take(200).collect::<String>()
        );

        // Prepend any text accumulated across reconnects in this recording.
        let prefix = app_inner.accumulated_text.lock().await.clone();
        let combined = format!("{}{}", prefix, session_text);

        session.close();
        {
            let mut slot = app_inner.asr_session.lock().await;
            if !is_current_epoch(&app_inner, my_epoch) {
                return;
            }
            slot.take();
        }
        // 5-9. Polish (if applicable), write clipboard, paste, record stats, end cue.
        let outcome =
            finalize::finalize_and_paste(&app_handle, &app_inner, combined, my_epoch).await;

        if !is_current_epoch(&app_inner, my_epoch) {
            return;
        }

        if outcome == finalize::FinalizeOutcome::Deferred {
            // A failed polish parked the text and already settled the app state:
            // leave the overlay up so the user can retry, ESC out, or let it
            // auto-paste.
            *app_inner.accumulated_text.lock().await = String::new();
            return;
        }
    } else {
        if !is_current_epoch(&app_inner, my_epoch) {
            return;
        }
        finalize::finalize_on_failure(
            &app_handle,
            &app_inner,
            connection_error
                .as_ref()
                .unwrap_or(&AppError::new(AppErrorCode::AsrFinalizeIncomplete)),
            my_epoch,
        )
        .await;
        return;
    }

    // 11. Clear cross-reconnect accumulated text for the next recording.
    *app_inner.accumulated_text.lock().await = String::new();

    // Successful output owns its feedback lifetime.
    if !app_inner
        .feedback_visible
        .load(std::sync::atomic::Ordering::SeqCst)
    {
        overlay::hide(&app_handle);
        set_app_state(&app_handle, &app_inner, app_state::AppState::Idle).await;
    }
}

/// Tear down an in-flight retry or a shown retryable failure: discard any
/// in-flight result via the epoch bump, clear retry state, and hide the overlay.
pub(super) async fn abort_retry_or_failure(
    app_handle: &AppHandle,
    app_inner: &Arc<app_state::AppInner>,
) {
    app_inner
        .session_epoch
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    if let Some(session) = app_inner.asr_session.lock().await.take() {
        session.close();
    }
    capture::stop_capture(app_inner).await;
    app_inner.pending_audio.lock().await.clear();
    *app_inner.current_retry_of.lock().await = None;
    *app_inner.current_failure_ts.lock().await = None;
    *app_inner.latest_transcript.lock().await = (String::new(), String::new());
    *app_inner.accumulated_text.lock().await = String::new();
    let _ = app_handle.emit("overlay:event", serde_json::json!({ "type": "reset" }));
    overlay::hide(app_handle);
    // set_app_state(Idle) also re-syncs (disables) the ESC shortcut.
    set_app_state(app_handle, app_inner, app_state::AppState::Idle).await;
}

pub(super) async fn cancel_recording(app_handle: AppHandle) {
    let app_inner = app_handle.state::<Arc<app_state::AppInner>>();
    let recording_state = app_handle.state::<RecordingState>();

    let should_cancel = {
        let recording = recording_state.0.lock().unwrap();
        *recording
    };
    if !should_cancel {
        return;
    }

    *recording_state.0.lock().unwrap() = false;
    log_rec!(debug, "Cancel requested");

    // Bump the epoch so any in-flight background connect task discards its
    // result, and drop any audio buffered before the session was ready.
    app_inner
        .session_epoch
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    app_inner.pending_audio.lock().await.clear();
    app_inner.recording_audio.lock().await.clear();
    *app_inner.current_recording_wav.lock().await = None;
    *app_inner.current_retry_of.lock().await = None;

    // Clear the active prompt ID since the session was cancelled
    if let Some(active) = app_handle.try_state::<ActivePromptId>() {
        *active.0.lock().unwrap() = None;
    }

    capture::stop_capture(&app_inner).await;

    if let Some(session) = app_inner.asr_session.lock().await.take() {
        session.close();
    }
    *app_inner.asr_events.lock().await = None;
    *app_inner.latest_transcript.lock().await = (String::new(), String::new());
    *app_inner.accumulated_text.lock().await = String::new();

    let _ = app_handle.emit("overlay:event", serde_json::json!({ "type": "reset" }));
    overlay::hide(&app_handle);
    set_app_state(&app_handle, &app_inner, app_state::AppState::Idle).await;

    // Resync the hotkey matcher: the recording was cancelled out-of-band
    // (ESC), so it must not still believe a session is active.
    reset_matcher_recording(&app_handle);
}
