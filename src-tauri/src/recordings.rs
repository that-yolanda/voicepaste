//! Recording artifact management: saving diagnostic WAVs, recording
//! success/failure stats with audio retention, and pruning stale recordings.

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Manager};

use crate::app_state;
use crate::overlay;
use crate::wav;

/// Save the captured session PCM as a 16k mono WAV under `<data>/recordings/`.
/// Returns the existing path when no new samples were captured. Stores the path
/// on the shared state so failures/retries can reference it.
pub(crate) async fn save_recording_wav(
    app: &AppHandle,
    app_inner: &Arc<app_state::AppInner>,
) -> Option<PathBuf> {
    let samples = {
        let mut audio = app_inner.recording_audio.lock().await;
        if audio.is_empty() {
            return app_inner.current_recording_wav.lock().await.clone();
        }
        std::mem::take(&mut *audio)
    };

    let data_dir = match app.path().app_data_dir() {
        Ok(dir) => dir,
        Err(error) => {
            log_audio!(
                warn,
                "Resolve app data dir for recording WAV failed: {}",
                error
            );
            return None;
        }
    };
    let output_dir = data_dir.join("recordings");
    if let Err(error) = std::fs::create_dir_all(&output_dir) {
        log_audio!(
            warn,
            "Create recording WAV directory failed ({}): {}",
            output_dir.display(),
            error
        );
        return None;
    }

    let ts = chrono::Local::now().format("%Y%m%d-%H%M%S%.3f");
    let path = output_dir.join(format!("voicepaste-{ts}.wav"));
    match wav::write_wav_16k_mono(&path, &samples) {
        Ok(()) => {
            log_audio!(info, "Recording WAV saved: {}", path.display());
            *app_inner.current_recording_wav.lock().await = Some(path.clone());
            Some(path)
        }
        Err(error) => {
            log_audio!(
                warn,
                "Write recording WAV failed ({}): {}",
                path.display(),
                error
            );
            None
        }
    }
}

pub(crate) async fn current_recording_wav_string(
    app_inner: &Arc<app_state::AppInner>,
) -> Option<String> {
    app_inner
        .current_recording_wav
        .lock()
        .await
        .as_ref()
        .map(|path| path.to_string_lossy().to_string())
}

/// Record a transcription failure into stats, arm the overlay retry affordance,
/// and remember its timestamp so the main hotkey can retry it.
pub(crate) async fn record_transcription_failure(
    app: &AppHandle,
    app_inner: &Arc<app_state::AppInner>,
    message: &str,
) -> String {
    let audio_path = current_recording_wav_string(app_inner).await;
    let retry_of = app_inner.current_retry_of.lock().await.clone();
    let ts = app_inner
        .stats
        .lock()
        .await
        .record_failure(message, audio_path, retry_of);
    *app_inner.current_failure_ts.lock().await = Some(ts.clone());
    overlay::set_overlay_retry_interaction(app, true);
    ts
}

/// Delete WAVs older than 31 days from `<data>/recordings/`.
pub(crate) fn prune_old_recordings(app: &AppHandle) {
    let Ok(data_dir) = app.path().app_data_dir() else {
        return;
    };
    let recordings_dir = data_dir.join("recordings");
    let Ok(entries) = std::fs::read_dir(recordings_dir) else {
        return;
    };
    let cutoff = std::time::SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(31 * 24 * 60 * 60))
        .unwrap_or(std::time::UNIX_EPOCH);

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("wav") {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        if modified < cutoff {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Drop the WAV and recording bookkeeping for a recording that produced nothing
/// worth keeping (e.g. the user stopped without speaking). Nothing to retry.
pub(crate) async fn discard_recording_artifacts(app_inner: &Arc<app_state::AppInner>) {
    if let Some(path) = app_inner.current_recording_wav.lock().await.take() {
        let _ = std::fs::remove_file(path);
    }
    *app_inner.current_retry_of.lock().await = None;
    *app_inner.current_failure_ts.lock().await = None;
    app_inner.recording_audio.lock().await.clear();
}

/// Record a successful transcription into stats, honoring the keep-recordings
/// setting (delete the WAV when off), and run the retention sweep. Replaces the
/// retried history entry in place when this success retries a prior failure.
pub(crate) async fn record_success_and_apply_retention(
    app: &AppHandle,
    app_inner: &Arc<app_state::AppInner>,
    text: &str,
    keep_recordings: bool,
) {
    let wav_path = app_inner.current_recording_wav.lock().await.take();
    let retry_of = app_inner.current_retry_of.lock().await.take();
    let audio_path = if keep_recordings {
        wav_path
            .as_ref()
            .map(|path| path.to_string_lossy().to_string())
    } else {
        if let Some(path) = wav_path {
            let _ = std::fs::remove_file(path);
        }
        None
    };
    let mut stats = app_inner.stats.lock().await;
    if let Some(retry_ts) = retry_of.as_ref() {
        if stats.replace_history_with_success(retry_ts, text, audio_path.clone()) {
            drop(stats);
            // Always prune: a never-retried failure recording is only deleted on a
            // later success, otherwise it is reclaimed by the 31-day retention sweep,
            // even when keep_recordings is off (only failure WAVs persist then).
            prune_old_recordings(app);
            return;
        }
    }
    stats.record_session_with_audio(text, audio_path, retry_of);
    drop(stats);

    prune_old_recordings(app);
}
