//! Finalize-and-paste finishing flow: optional LLM polishing, trailing-period
//! trimming, clipboard write, simulated paste, usage stats, and the end cue.
//! Also handles the salvage path when a recording fails mid-stream.

use std::sync::Arc;

use tauri::{AppHandle, Manager};

use crate::app_state::{self, set_app_state, ActivePromptId, RecordingState};
use crate::overlay;

use super::capture;
use super::cue;
use super::history;
use super::{current_session_text, emit_hint, reset_matcher_recording};

/// Finalize a recording that failed mid-stream (fatal error or exhausted
/// reconnects): salvage the accumulated text plus the current session's text and
/// run it through the normal paste pipeline, then tear down and hide the overlay.
pub(super) async fn finalize_on_failure(
    app: &AppHandle,
    app_inner: &Arc<app_state::AppInner>,
    message: &str,
) {
    // Stop recording so audio routing and hotkey toggling settle.
    if let Some(state) = app.try_state::<RecordingState>() {
        *state.0.lock().unwrap() = false;
    }
    reset_matcher_recording(app);

    // Gather salvageable text: accumulated prefix + the dying session's text.
    let session_text = current_session_text(app_inner).await;
    if let Some(s) = app_inner.asr_session.lock().await.take() {
        s.close();
    }

    let prefix = app_inner.accumulated_text.lock().await.clone();
    let combined = format!("{}{}", prefix, session_text);

    // Reset cross-reconnect / buffering state.
    *app_inner.accumulated_text.lock().await = String::new();
    *app_inner.latest_transcript.lock().await = (String::new(), String::new());
    *app_inner.asr_events.lock().await = None;
    app_inner.pending_audio.lock().await.clear();

    capture::stop_capture(app_inner).await;
    history::save_recording_wav(app, app_inner).await;

    if combined.trim().is_empty() {
        history::record_transcription_failure(app, app_inner, message).await;
        // Nothing to salvage: surface the error so the user understands the abort.
        log_events!(warn, "ASR failed with no recognized text: {}", message);
        overlay::emit_retryable_error_hint(app, app_inner, message).await;
        if let Some(active) = app.try_state::<ActivePromptId>() {
            *active.0.lock().unwrap() = None;
        }
        set_app_state(app, app_inner, app_state::AppState::Idle).await;
        overlay::schedule_retry_overlay_hide(app.clone(), Arc::clone(app_inner));
        return;
    }

    // Salvaged text exists: paste it as if the recording had ended normally.
    log_events!(
        warn,
        "ASR failed; salvaging recognized text ({} chars): {}",
        combined.chars().count(),
        message
    );
    finalize_and_paste(app, app_inner, combined).await;

    if let Some(overlay) = app.get_window("overlay") {
        let _ = overlay.hide();
    }
    set_app_state(app, app_inner, app_state::AppState::Idle).await;
}

/// Run recognized text through the finishing pipeline: optional LLM polishing
/// (prompt-specific hotkeys only, with sherpa-onnx hotword hinting), trailing-
/// period trimming, clipboard write (honoring keep_clipboard), simulated paste,
/// usage stats, and the end cue. Shared by the normal stop path and the
/// failure-salvage path.
pub(super) async fn finalize_and_paste(
    app_handle: &AppHandle,
    app_inner: &Arc<app_state::AppInner>,
    raw_text: String,
) {
    let trimmed = raw_text.trim().to_string();

    // Always clear the active prompt ID once a recording concludes.
    let mut active_prompt_id = app_handle
        .try_state::<ActivePromptId>()
        .and_then(|s| s.0.lock().unwrap().clone());
    if let Some(active) = app_handle.try_state::<ActivePromptId>() {
        *active.0.lock().unwrap() = None;
    }

    if trimmed.is_empty() {
        log_rec!(warn, "Final text is empty, skipping paste");
        return;
    }

    log_rec!(
        info,
        "Final text received ({} chars)",
        trimmed.chars().count()
    );
    log_rec!(
        debug,
        "Final text preview: {:?}",
        trimmed.chars().take(200).collect::<String>()
    );

    // Load config + model registry for LLM / behavior settings.
    let config = app_inner.config_manager.load_config().ok();

    // When a prompt-specific stop chord was used, validate the LLM config up
    // front: a missing key/URL/model would otherwise surface as a generic
    // "润色失败" after a failed call. Downgrade to raw text on error.
    if active_prompt_id.is_some() {
        if let Some(ref cfg) = config {
            if let Err(e) = crate::llm::validate_llm_config(&cfg.llm) {
                log_rec!(warn, "LLM config invalid, skipping polish: {}", e);
                emit_hint(app_handle, &e, "warn", "text");
                active_prompt_id = None;
            }
        }
    }
    let resource_dir = app_handle
        .path()
        .resource_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    let data_dir = app_handle
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    let registry = crate::model::load_registry(&data_dir, &resource_dir);

    let mut trimmed = trimmed;

    // Restore hotword casing for engines configured to do so (e.g. sherpa-onnx
    // lowercases proper nouns recognized via its hotword list).
    if let Some(ref config) = config {
        let model_id = config.audio_provider();
        if config.hotword_replace(model_id, &registry) {
            let hotwords = app_inner.hotword_manager.active_words();
            if !hotwords.is_empty() {
                trimmed = crate::asr::apply_post_asr_corrections(
                    &trimmed, &hotwords, &registry, model_id,
                );
            }
        }
    }

    if config
        .as_ref()
        .map(|config| config.app.remove_trailing_period)
        .unwrap_or(true)
        && (trimmed.ends_with('。') || trimmed.ends_with('.'))
    {
        trimmed.pop();
    }

    // Apply LLM structure_text only when a prompt-specific hotkey was used.
    // The main hotkey (active_prompt_id = None) pastes raw text without polishing.
    let final_text = match &config {
        Some(config) if active_prompt_id.is_some() => {
            let prompts = app_inner.config_manager.load_prompts();
            let hotwords = app_inner.hotword_manager.active_words();
            // Show a "润色中…" hint (with shimmer) while the LLM is working.
            emit_hint(app_handle, "润色中…", "info", "progress");
            match crate::llm::polish_transcript(
                config,
                &prompts,
                active_prompt_id.as_deref(),
                &hotwords,
                &registry,
                &trimmed,
            )
            .await
            {
                crate::llm::PolishOutcome::Polished(t) => {
                    log_rec!(
                        info,
                        "LLM polishing succeeded ({} chars)",
                        t.chars().count()
                    );
                    log_rec!(
                        debug,
                        "LLM polished preview: {:?}",
                        t.chars().take(200).collect::<String>()
                    );
                    t
                }
                crate::llm::PolishOutcome::Failed(e) => {
                    log_rec!(warn, "LLM polishing failed: {}, using raw text", e);
                    emit_hint(app_handle, "文本润色失败，已输出原文", "warn", "text");
                    trimmed.clone()
                }
                crate::llm::PolishOutcome::NotPolished => trimmed.clone(),
            }
        }
        _ => trimmed.clone(),
    };

    // Write to clipboard
    use tauri_plugin_clipboard_manager::ClipboardExt;

    // Save original clipboard content if we need to restore it later
    let keep_clipboard = config
        .as_ref()
        .map(|c| c.app.keep_clipboard)
        .unwrap_or(true);
    let original_clipboard: Option<String> = if !keep_clipboard {
        app_handle.clipboard().read_text().ok()
    } else {
        None
    };

    if let Err(e) = app_handle.clipboard().write_text(&final_text) {
        log_rec!(error, "Clipboard write failed: {}", e);
        emit_hint(
            app_handle,
            &format!("剪贴板写入失败: {}", e),
            "error",
            "text",
        );
    }

    // Simulate paste keystroke
    let _result = crate::paste::simulate_paste();

    // Restore original clipboard content if keep_clipboard is disabled
    if let Some(original) = original_clipboard {
        if let Err(e) = app_handle.clipboard().write_text(&original) {
            log_rec!(error, "Failed to restore clipboard: {}", e);
        }
    }

    // Record usage stats and retain/delete the WAV according to user settings.
    let keep_recordings = config
        .as_ref()
        .map(|c| c.app.keep_recordings)
        .unwrap_or(false);
    history::record_success_and_apply_retention(
        app_handle,
        app_inner,
        &final_text,
        keep_recordings,
    )
    .await;
    cue::emit_cue(app_handle, app_inner, "end");
}
