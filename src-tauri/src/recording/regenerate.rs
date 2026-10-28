//! Silent regenerate pipeline: re-transcribe a kept history recording through a
//! fresh ASR session and rewrite the entry's text in place, without touching the
//! overlay, app state, clipboard, or focused window. Used from the settings
//! history list when a successful transcription lost content and the user wants
//! a clean redo of the saved audio.

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Manager};

use crate::app_state;

use super::session;
use super::wav;

/// PCM chunk size (samples) fed to the ASR session when replaying a stored
/// recording. Matches the live capture chunk size.
const REGEN_CHUNK_SIZE: usize = 1600;

/// Re-transcribe the saved recording of a history entry and rewrite its text in
/// place. Requires the entry to have a kept recording (only present when
/// "keep recording" was on for that session). Runs silently: no overlay, no
/// paste, no app-state changes. Returns the regenerated text on success.
pub(crate) async fn regenerate_history_transcription(
    app_handle: AppHandle,
    ts: String,
) -> Result<serde_json::Value, crate::errors::AppError> {
    use crate::errors::{AppError, AppErrorCode};

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
        .ok_or_else(|| AppError::new(AppErrorCode::StatsNoRecordingKept))?;
    let path = PathBuf::from(&audio_path);
    let samples = wav::read_wav_16k_mono(&path)?;
    if samples.is_empty() {
        return Err(AppError::new(AppErrorCode::StatsEmptyRecording));
    }

    let config = app_inner
        .config_manager
        .load_config()
        .map_err(|_| AppError::new(AppErrorCode::InvalidConfig))?;
    let hotwords = app_inner.hotword_manager.active_words();

    // Keep the event receiver alive for the session's lifetime but never drain it
    // into the overlay: regeneration is silent. `commit_and_await_final` resolves
    // through the session's own commit channel, independent of this receiver.
    let (session, _event_rx, _) =
        session::create_active_session(&app_handle, &config, &hotwords).await?;
    let session: Arc<dyn crate::asr::AsrSession> = Arc::from(session);

    for chunk in samples.chunks(REGEN_CHUNK_SIZE) {
        session.append_audio(chunk);
    }

    let text = session.commit_and_await_final().await;
    session.close();
    let text = text?;
    let text = text.trim();
    if text.is_empty() {
        return Err(AppError::new(AppErrorCode::AsrEmptyResult));
    }

    // Mirror the finishing pipeline's lightweight text cleanup (LLM polishing is
    // intentionally skipped, as with the failure retry path): restore hotword
    // casing for engines that lowercase proper nouns, then trim a trailing
    // sentence period when the user has that enabled.
    let final_text = apply_post_asr_cleanup(&app_handle, &config, &hotwords, text);

    let updated = app_inner
        .stats
        .lock()
        .await
        .update_history_text(&ts, &final_text);
    if !updated {
        return Err(AppError::new(AppErrorCode::StatsUpdateFailed));
    }

    log_rec!(
        info,
        "Regenerated history entry ({} chars)",
        final_text.chars().count()
    );
    Ok(serde_json::json!({ "ok": true, "text": final_text }))
}

/// Apply hotword case restoration and trailing-period trimming, matching the
/// non-LLM portion of the normal finishing pipeline (`finalize_and_paste`).
fn apply_post_asr_cleanup(
    app_handle: &AppHandle,
    config: &crate::config::AppConfig,
    hotwords: &[String],
    text: &str,
) -> String {
    let resource_dir = app_handle
        .path()
        .resource_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let data_dir = app_handle
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let registry = crate::model::load_registry(&data_dir, &resource_dir);

    let mut cleaned = text.to_string();
    let model_id = config.audio_provider();
    if config.hotword_replace(model_id, &registry) && !hotwords.is_empty() {
        cleaned = crate::asr::apply_post_asr_corrections(&cleaned, hotwords);
    }

    if config.app.remove_trailing_period && (cleaned.ends_with('。') || cleaned.ends_with('.')) {
        cleaned.pop();
    }

    cleaned
}
