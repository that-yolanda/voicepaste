//! Recording cue sound: resolve the configured start/end sound path and play it
//! via rodio (see [`crate::sound`]). The cue tells the user recording started
//! or stopped.

use crate::app_state::AppInner;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::AppHandle;
use tauri::Manager;

/// Resolve the bundled default sound path for `filename`, falling back to the
/// source-tree assets dir during local dev when the resource dir has no copy.
fn resolve_default_sound_path(app: &AppHandle, filename: &str) -> PathBuf {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let packaged = resource_dir.join("sounds").join(filename);
        if packaged.exists() {
            return packaged;
        }
    }

    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("assets")
        .join("sounds")
        .join(filename)
}

/// Resolve the configured sound file path for `name` ("start" / "end").
/// Returns `None` when sounds are disabled or the config cannot be loaded.
fn resolve_configured_sound_path(
    app: &AppHandle,
    app_inner: &Arc<AppInner>,
    name: &str,
) -> Option<String> {
    let config = match app_inner.config_manager.load_config() {
        Ok(config) => config,
        Err(error) => {
            log_app!(warn, "Sound config load failed: {}", error);
            return None;
        }
    };

    let sound_config = config.app.sound.as_ref();
    if sound_config.map(|sound| !sound.enabled).unwrap_or(false) {
        return None;
    }

    let custom_path = match name {
        "start" => sound_config
            .map(|sound| sound.start_sound.trim())
            .unwrap_or(""),
        "end" => sound_config
            .map(|sound| sound.end_sound.trim())
            .unwrap_or(""),
        _ => "",
    };
    let file_path = if custom_path.is_empty() {
        let filename = if name == "start" {
            "start.mp3"
        } else {
            "end.mp3"
        };
        resolve_default_sound_path(app, filename)
            .to_string_lossy()
            .to_string()
    } else {
        custom_path.to_string()
    };

    Some(file_path)
}

/// Play a cue (`name` = "start" / "end") through rodio in the backend process.
/// Playing in-process (instead of spawning `afplay`/PowerShell or routing through
/// the renderer's AudioContext) keeps the cue full-volume, immune to the overlay
/// WebView being torn down mid-playback, and free of decode/keep-alive jank.
pub(crate) fn emit_cue(app: &AppHandle, app_inner: &Arc<AppInner>, name: &str) {
    let Some(file_path) = resolve_configured_sound_path(app, app_inner, name) else {
        return;
    };
    crate::sound::play_audio_file(&file_path);
}
