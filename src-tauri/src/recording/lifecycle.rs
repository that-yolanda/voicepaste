//! Recording lifecycle: start, stop, cancel, and retry/failure abort paths.

use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::app_state::{self, set_app_state, ActivePromptId, RecordingState};
use crate::overlay;

use super::capture;
use super::cue;
use super::finalize;
use super::history;
use super::session;
use super::wav;
use super::{emit_hint, reset_matcher_recording};

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
            emit_hint(
                &app_handle,
                &format!("配置加载失败: {}", e),
                "error",
                "text",
            );
            return;
        }
    };

    // Prompt-specific LLM validation is deferred to finalize_and_paste: the
    // prompt is resolved from the stop chord (not known at start), and a bad
    // LLM config surfaces there as "文本润色失败，已输出原文" with the raw text.

    *app_inner.latest_transcript.lock().await = (String::new(), String::new());
    app_inner.recording_audio.lock().await.clear();
    *app_inner.current_recording_wav.lock().await = None;
    *app_inner.current_retry_of.lock().await = None;
    *app_inner.current_failure_ts.lock().await = None;
    overlay::set_overlay_retry_interaction(&app_handle, false);
    let _ = app_handle.emit("overlay:event", serde_json::json!({ "type": "reset" }));
    // Re-position before showing so the overlay follows the current display layout
    // (e.g. after an external monitor was connected/disconnected).
    overlay::position_overlay(&app_handle);
    if let Some(overlay) = app_handle.get_window("overlay") {
        let _ = overlay.show();
    }

    // 2. Warm up microphone capture (native cpal on macOS + Windows). The capture
    //    owns its own ready signal (a oneshot the input thread fires once the
    //    stream is built), so there is no renderer warmup round-trip to wait on.
    set_app_state(&app_handle, &app_inner, app_state::AppState::Connecting).await;
    if let Err(e) = capture::start_capture(app_handle.clone(), Arc::clone(&app_inner)).await {
        *recording_state.0.lock().unwrap() = false;
        set_app_state(&app_handle, &app_inner, app_state::AppState::Idle).await;
        if let Some(overlay) = app_handle.get_window("overlay") {
            let _ = overlay.hide();
        }
        log_rec!(warn, "Native audio warmup failed: {}", e);
        emit_hint(&app_handle, &e, "error", "text");
        return;
    }

    // Check if recording was cancelled during warmup (hold mode: quick press-release)
    if !*recording_state.0.lock().unwrap() {
        log_rec!(warn, "Cancelled during warmup, aborting start");
        capture::stop_capture(&app_inner).await;
        set_app_state(&app_handle, &app_inner, app_state::AppState::Idle).await;
        if let Some(overlay) = app_handle.get_window("overlay") {
            let _ = overlay.hide();
        }
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

    let (connect_tx, connect_rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
    *app_inner.connect_rx.lock().await = Some(connect_rx);

    cue::emit_cue(&app_handle, &app_inner, "start");
    set_app_state(&app_handle, &app_inner, app_state::AppState::Recording).await;

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

    // Mark as not recording
    *recording_state.0.lock().unwrap() = false;

    // 1. Set state to finishing
    set_app_state(&app_handle, &app_inner, app_state::AppState::Finishing).await;

    // 2. Stop renderer audio first so the final buffered chunk is flushed.
    capture::stop_capture(&app_inner).await;
    // Snapshot whether real sound was captured before save_recording_wav drains
    // the buffer: a silent stop ends immediately, but speech whose transcript was
    // lost (slow/failed network) must keep the retry path even with no result yet.
    let captured_audio_signal = {
        let audio = app_inner.recording_audio.lock().await;
        wav::recording_has_audio_signal(&audio)
    };
    history::save_recording_wav(&app_handle, &app_inner).await;

    // 3. Acquire the ready ASR session. If the background connect hasn't finished
    //    (user stopped before it was ready), wait for it to resolve so the buffered
    //    audio still gets transcribed instead of being thrown away.
    let session = match app_inner.asr_session.lock().await.take() {
        Some(s) => Some(s),
        None => {
            // If the recording was too short to contain speech and nothing was
            // recognized, cancel the in-flight connect rather than waiting up to
            // 12 s for a session that will only time out on the server side.
            // Genuine speech (signal present) still waits so the buffered audio
            // gets transcribed instead of being thrown away.
            if !captured_audio_signal {
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
                    overlay::set_overlay_retry_interaction(&app_handle, false);
                    if let Some(overlay) = app_handle.get_window("overlay") {
                        let _ = overlay.hide();
                    }
                    set_app_state(&app_handle, &app_inner, app_state::AppState::Idle).await;
                    return;
                }
            }
            let rx = app_inner.connect_rx.lock().await.take();
            match rx {
                Some(rx) => match tokio::time::timeout(Duration::from_secs(12), rx).await {
                    Ok(Ok(Ok(()))) => app_inner.asr_session.lock().await.take(),
                    _ => None, // connect failed / timed out / task gone
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
        if !recognized_anything && !captured_audio_signal {
            log_rec!(info, "Stop with no recognized speech; ending immediately");
            session.close();
            app_inner.pending_audio.lock().await.clear();
            *app_inner.accumulated_text.lock().await = String::new();
            history::discard_recording_artifacts(&app_inner).await;
            overlay::set_overlay_retry_interaction(&app_handle, false);
            if let Some(overlay) = app_handle.get_window("overlay") {
                let _ = overlay.hide();
            }
            set_app_state(&app_handle, &app_inner, app_state::AppState::Idle).await;
            return;
        }

        // 5. Commit and get this session's final text.
        let session_text = match session.commit_and_await_final().await {
            Ok(t) => t,
            Err(e) => {
                log_rec!(warn, "ASR commit failed: {}", e);
                session.close();
                app_inner.pending_audio.lock().await.clear();
                *app_inner.accumulated_text.lock().await = String::new();
                history::record_transcription_failure(&app_handle, &app_inner, &e).await;
                overlay::emit_retryable_error_hint(&app_handle, &app_inner, &e).await;
                set_app_state(&app_handle, &app_inner, app_state::AppState::Idle).await;
                overlay::schedule_retry_overlay_hide(app_handle.clone(), Arc::clone(&app_inner));
                return;
            }
        };
        log_rec!(
            debug,
            "ASR commit final text ({} chars): {:?}",
            session_text.chars().count(),
            session_text.chars().take(200).collect::<String>()
        );

        // Prepend any text accumulated across reconnects in this recording.
        let prefix = app_inner.accumulated_text.lock().await.clone();
        let combined = format!("{}{}", prefix, session_text);

        // 5-9. Polish (if applicable), write clipboard, paste, record stats, end cue.
        finalize::finalize_and_paste(&app_handle, &app_inner, combined).await;

        // 10. Close the WebSocket session
        session.close();
    } else {
        // No ready session: the connect never completed (or we stopped during a
        // reconnect gap). Drop any buffered audio for this round.
        app_inner.pending_audio.lock().await.clear();
        let prefix = app_inner.accumulated_text.lock().await.clone();
        if !prefix.trim().is_empty() {
            // Salvage text accumulated before the disconnect instead of discarding.
            log_rec!(
                warn,
                "Stop with no ready session; salvaging accumulated text"
            );
            finalize::finalize_and_paste(&app_handle, &app_inner, prefix).await;
        } else {
            log_rec!(
                warn,
                "Stop with no ready ASR session; discarding buffered audio"
            );
            let message = "语音服务连接失败，请检查网络连接";
            history::record_transcription_failure(&app_handle, &app_inner, message).await;
            overlay::emit_retryable_error_hint(&app_handle, &app_inner, message).await;
            *app_inner.accumulated_text.lock().await = String::new();
            set_app_state(&app_handle, &app_inner, app_state::AppState::Idle).await;
            overlay::schedule_retry_overlay_hide(app_handle.clone(), Arc::clone(&app_inner));
            return;
        }
    }

    // 11. Clear cross-reconnect accumulated text for the next recording.
    *app_inner.accumulated_text.lock().await = String::new();

    // 12. Hide overlay
    overlay::set_overlay_retry_interaction(&app_handle, false);
    if let Some(overlay) = app_handle.get_window("overlay") {
        let _ = overlay.hide();
    }

    // 13. Set state back to idle
    set_app_state(&app_handle, &app_inner, app_state::AppState::Idle).await;
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
    *app_inner.current_retry_of.lock().await = None;
    *app_inner.current_failure_ts.lock().await = None;
    *app_inner.latest_transcript.lock().await = (String::new(), String::new());
    *app_inner.accumulated_text.lock().await = String::new();
    overlay::set_overlay_retry_interaction(app_handle, false);
    let _ = app_handle.emit("overlay:event", serde_json::json!({ "type": "reset" }));
    if let Some(overlay) = app_handle.get_window("overlay") {
        let _ = overlay.hide();
    }
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
    if let Some(overlay) = app_handle.get_window("overlay") {
        let _ = overlay.hide();
    }
    set_app_state(&app_handle, &app_inner, app_state::AppState::Idle).await;

    // Resync the hotkey matcher: the recording was cancelled out-of-band
    // (ESC), so it must not still believe a session is active.
    reset_matcher_recording(&app_handle);
}
