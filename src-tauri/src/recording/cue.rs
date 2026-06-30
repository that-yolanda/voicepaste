//! Cue sound playback via rodio (macOS + Windows).
//!
//! Replaces both the per-platform process spawns (afplay / PowerShell
//! `SoundPlayer`) and the renderer-side `AudioContext`. Playing in the long-lived
//! backend process means a cue is never cut short by the overlay WebView being
//! torn down, and there is no decode/keep-alive jank. rodio decodes via symphonia
//! (mp3 out of the box) and handles resampling internally, so no sample-rate
//! matching is needed.

use crate::app_state::AppInner;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::AppHandle;
use tauri::Manager;

/// Play a cue sound file on a background thread. The thread blocks on
/// `sleep_until_end` so the `OutputStream` stays alive for the whole cue.
/// Errors are logged only — rodio + symphonia is stable enough that no fallback
/// (afplay/PowerShell) is warranted.
pub fn play_cue_file(file_path: &str) {
    if file_path.is_empty() {
        return;
    }
    let path = file_path.to_string();
    if let Err(error) = std::thread::Builder::new()
        .name("voicepaste-cue".to_string())
        .spawn(move || {
            if let Err(error) = play(&path) {
                log_app!(warn, "Cue playback failed ({}): {}", path, error);
            }
        })
    {
        log_app!(warn, "Failed to spawn cue thread: {}", error);
    }
}

fn play(path: &str) -> Result<(), Box<dyn std::error::Error>> {
    use std::fs::File;
    use std::io::BufReader;
    // Keep `_stream` alive for the whole call: dropping it stops playback.
    let (_stream, handle) = rodio::OutputStream::try_default()?;
    let sink = rodio::Sink::try_new(&handle)?;
    let file = File::open(path)?;
    sink.append(rodio::Decoder::new(BufReader::new(file))?);
    sink.sleep_until_end();
    Ok(())
}

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
    play_cue_file(&file_path);
}
