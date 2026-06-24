#[macro_use]
mod logger;
mod app_state;
mod asr;
mod commands;
mod config;
mod hotkey;
mod hotword;
mod llm;
mod migration;
mod model;
#[cfg(target_os = "macos")]
mod native_audio;
mod overlay;
mod paste;
mod stats;
#[cfg(test)]
mod tests;
mod updater;

use app_state::*;
use asr::AsrEngine;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::{
    image::Image, tray::TrayIconBuilder, App, AppHandle, Emitter, Listener, Manager, RunEvent,
};

/// Delay after the mic stream is ready, before entering Recording / playing the
/// start cue. The renderer (getUserMedia) path needs it so the browser's AEC/AGC
/// converge before the first words. Native cpal capture has no such DSP warmup,
/// so macOS uses 0 — testing whether dropped leading words / cue glitches return.
#[cfg(target_os = "macos")]
const AUDIO_SETTLE_MS: u64 = 0;
#[cfg(not(target_os = "macos"))]
const AUDIO_SETTLE_MS: u64 = 350;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Register updater plugin
            #[cfg(desktop)]
            {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
            }

            // Managed state for pending update
            app.manage(updater::PendingUpdate(std::sync::Mutex::new(None)));

            // Resolve data directories
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("Failed to resolve app data dir");
            let resource_dir = app
                .path()
                .resource_dir()
                .expect("Failed to resolve resource dir");

            // Ensure data directory exists
            std::fs::create_dir_all(&data_dir).ok();

            // Initialize the global logger first so every later step (registry
            // bootstrap, 1.x migration, config load) emits visible logs.
            let log_path = data_dir.join("voicepaste.log");
            let voice_logger = logger::VoiceLogger::new(log_path.clone());
            let log_level = if cfg!(debug_assertions) {
                log::LevelFilter::Debug
            } else {
                log::LevelFilter::Info
            };
            log::set_boxed_logger(Box::new(voice_logger)).expect("Failed to set global logger");
            log::set_max_level(log_level);

            model::ensure_registry(&data_dir, &resource_dir);

            // One-time migration from 1.x (Electron). Must run before
            // ConfigManager::new, which would otherwise overwrite the migrated
            // config.yaml with the empty example template. Best-effort: a
            // failure falls back to defaults and never blocks startup.
            if let Err(e) = migration::run(&data_dir, &resource_dir) {
                log_app!(warn, "config migration failed (app will use defaults): {e}");
            }

            // Initialize services
            let config_manager = config::ConfigManager::new(&data_dir, &resource_dir);
            let stats_service = stats::StatsService::new(&data_dir);
            let hotword_manager = hotword::HotwordManager::new(&data_dir, &resource_dir);

            // Read startup config before config_manager is moved into app state.
            let startup_config = config_manager.load_config().ok();
            let hotkey_mode = startup_config
                .as_ref()
                .map(|c| c.app.hotkey_mode.clone())
                .unwrap_or_else(|| "toggle".to_string());
            let initial_theme = startup_config
                .as_ref()
                .map(|c| c.app.theme.as_str())
                .unwrap_or("system")
                .to_string();

            let app_state =
                create_app_state(config_manager, hotword_manager, log_path, stats_service);
            app.manage(app_state);

            // Recording state toggle (used by global shortcut handler)
            app.manage(RecordingState(std::sync::Mutex::new(false)));

            // Hotkey mode: "toggle" or "hold"
            app.manage(HotkeyMode(std::sync::Mutex::new(hotkey_mode)));

            // Active prompt ID for the current recording session (None = main hotkey)
            app.manage(ActivePromptId(std::sync::Mutex::new(None)));

            commands::apply_app_theme(app.handle(), &initial_theme);

            log_app!(info, "Setup complete");
            log_app!(debug, "data_dir: {:?}", data_dir);
            log_app!(debug, "resource_dir: {:?}", resource_dir);

            // Setup overlay window properties
            setup_overlay_window(app);

            // Mirror every overlay:event to the native macOS renderer (no-op on Windows).
            // The backend already emits these for the WebView; we tap the same stream so
            // the native AppKit pill stays in sync without touching each emit site.
            let overlay_handle = app.handle().clone();
            app.listen_any("overlay:event", move |event| {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(event.payload()) {
                    overlay::handle_event(&overlay_handle, &value);
                }
            });

            // Setup system tray
            setup_tray(app)?;

            // Setup global hotkeys via keytap
            log_app!(debug, "Setting up global hotkeys (keytap)...");
            setup_keytap_hotkeys(app)?;
            log_app!(info, "Global hotkeys ready");

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_app_config,
            commands::get_audio_config_defaults,
            commands::get_settings_data,
            commands::save_config_object,
            commands::load_prompts,
            commands::save_prompts,
            commands::get_stats,
            commands::get_history,
            commands::delete_history,
            commands::retry_history_transcription,
            commands::retry_latest_failed_transcription,
            commands::send_audio_chunk,
            commands::audio_stopped,
            commands::audio_warmup_ready,
            commands::audio_warmup_failed,
            commands::send_diagnostic,
            commands::paste_text,
            commands::get_microphone_status,
            commands::request_microphone_access,
            commands::get_accessibility_status,
            commands::open_accessibility_settings,
            commands::reinit_hotkey,
            commands::record_hotkey,
            commands::select_sound_file,
            commands::play_sound_file,
            commands::get_log_path,
            commands::get_config_path,
            commands::load_hotwords,
            commands::save_hotwords,
            commands::get_model_registry,
            commands::get_downloaded_models,
            commands::download_model,
            commands::delete_model,
            #[cfg(desktop)]
            updater::check_for_update,
            #[cfg(desktop)]
            updater::download_and_install_update,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            RunEvent::Ready => {
                // Position the overlay after the event loop is fully initialized,
                // avoiding "Window move completed without beginning" on macOS.
                position_overlay(app);
            }
            RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::CloseRequested { api, .. },
                ..
            } if label == "settings" => {
                api.prevent_close();
                if let Some(window) = app.get_webview_window("settings") {
                    let _ = window.hide();
                }
                set_dock_visible(false);
            }
            RunEvent::ExitRequested { code, api, .. }
                // Keep the app running in the tray for user-initiated window closes,
                // but allow tray "quit" to call app.exit(0).
                if code.is_none() =>
            {
                api.prevent_exit();
            }
            _ => {}
        });
}

/// Configure the overlay window.
/// Window properties (cursor_events, visible_on_all_workspaces) are deferred to
/// position_overlay() in RunEvent::Ready to avoid "Window move completed without
/// beginning" warnings on macOS.
fn setup_overlay_window(app: &App) {
    let _ = app.get_webview_window("overlay");
}

/// Position the overlay at bottom-center of the primary screen.
///
/// Called from RunEvent::Ready (to avoid macOS window server timing warnings) and
/// again every time the overlay is about to be shown. Re-running it on each show is
/// what lets the overlay follow display changes: when an external monitor is plugged
/// in or unplugged the primary monitor (and its work area) changes, but the window
/// keeps its old frame until repositioned — which previously required an app restart.
fn position_overlay(app_handle: &AppHandle) {
    if let Some(overlay) = app_handle.get_webview_window("overlay") {
        // Set window properties here (RunEvent::Ready) rather than during setup()
        // to avoid macOS window server timing issues.
        let _ = overlay.set_ignore_cursor_events(true);
        let _ = overlay.set_visible_on_all_workspaces(true);

        // Use the PRIMARY monitor's WORK AREA in LOGICAL units. The previous code
        // used physical pixels, which on a Retina (2x) display shrank the window to
        // half size and mispositioned it, and it measured from the full screen
        // height instead of the work area (ignoring the Dock / menu bar).
        if let Ok(Some(monitor)) = overlay.primary_monitor() {
            let scale = monitor.scale_factor();
            let work_area = monitor.work_area();
            let wa_x = work_area.position.x as f64 / scale;
            let wa_y = work_area.position.y as f64 / scale;
            let wa_w = work_area.size.width as f64 / scale;
            let wa_h = work_area.size.height as f64 / scale;

            let overlay_width = 720.0f64;
            let overlay_height = 300.0f64;
            let x = wa_x + (wa_w - overlay_width) / 2.0;
            let y = wa_y + wa_h - overlay_height - 48.0;

            let _ = overlay.set_size(tauri::Size::Logical(tauri::LogicalSize::new(
                overlay_width,
                overlay_height,
            )));
            let _ =
                overlay.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(x, y)));
        }
    }
}

fn set_overlay_retry_interaction(app_handle: &AppHandle, enabled: bool) {
    if let Some(overlay) = app_handle.get_webview_window("overlay") {
        let _ = overlay.set_ignore_cursor_events(!enabled);
    }
    if enabled {
        // The user's app is still frontmost here; remember it so a successful retry
        // can return focus before pasting (clicking the retry button activates the
        // overlay otherwise). Self-capture is filtered out inside the helper.
        overlay::capture_foreground_app(app_handle);
    }
}

/// Map one accelerator token to the symbol the settings UI shows. Mirrors the
/// frontend `normalizeHotkeyLabel` so the overlay label matches system settings.
fn normalize_hotkey_key(key: &str) -> &str {
    match key {
        "CmdOrCtrl" | "CommandOrControl" | "Command" | "Cmd" | "Meta" => "⌘",
        "Control" | "Ctrl" => "⌃",
        "Shift" => "⇧",
        "Alt" | "Option" => "⌥",
        "Space" => "␣",
        "ControlLeft" => "L ⌃",
        "ControlRight" => "R ⌃",
        "ShiftLeft" => "L ⇧",
        "ShiftRight" => "R ⇧",
        "AltLeft" => "L ⌥",
        "AltRight" => "R ⌥",
        "MetaLeft" => "L ⌘",
        "MetaRight" => "R ⌘",
        other => other,
    }
}

/// Format an accelerator string ("AltRight", "Control+Space") into the symbol
/// label shown in settings ("R ⌥", "⌃ ␣").
fn format_hotkey_label(hotkey: &str) -> String {
    hotkey
        .split('+')
        .map(|k| normalize_hotkey_key(k.trim()))
        .collect::<Vec<_>>()
        .join(" ")
}

/// The configured main hotkey, formatted for display. Empty for recorded keycode
/// sequences (which have no stable accelerator string).
async fn current_hotkey_label(app_inner: &Arc<app_state::AppInner>) -> String {
    let Ok(config) = app_inner.config_manager.load_config() else {
        return String::new();
    };
    match &config.app.hotkey {
        serde_norway::Value::String(s) => format_hotkey_label(s),
        _ => String::new(),
    }
}

/// Emit a retryable error hint, tagged with the main hotkey label so the overlay
/// can show which key (also) triggers the retry. Centralizes every failure path.
async fn emit_retryable_error_hint(
    app: &AppHandle,
    app_inner: &Arc<app_state::AppInner>,
    text: &str,
) {
    let hotkey = current_hotkey_label(app_inner).await;
    let _ = app.emit(
        "overlay:event",
        serde_json::json!({
            "type": "hint",
            "payload": {
                "text": text,
                "level": "error",
                "variant": "text",
                "retryable": true,
                "hotkey": hotkey
            }
        }),
    );
}

fn schedule_retry_overlay_hide(app_handle: AppHandle, app_inner: Arc<app_state::AppInner>) {
    // While the retry is shown (idle), keep ESC live so it can dismiss the failure.
    // set_app_state(Idle) just disabled it, so re-enable it here.
    set_escape_enabled_now(&app_handle, true);
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(5)).await;
        let still_idle = {
            let s = app_inner.state.lock().await;
            matches!(*s, app_state::AppState::Idle)
        };
        if still_idle {
            // The retry affordance is gone once the overlay hides, so drop the
            // pending failure: the hotkey reverts to starting a new recording.
            *app_inner.current_failure_ts.lock().await = None;
            set_escape_enabled_now(&app_handle, false);
            set_overlay_retry_interaction(&app_handle, false);
            if let Some(overlay) = app_handle.get_webview_window("overlay") {
                let _ = overlay.hide();
            }
        }
    });
}

fn app_state_name(state: &app_state::AppState) -> &'static str {
    match state {
        app_state::AppState::Idle => "idle",
        app_state::AppState::Connecting => "connecting",
        app_state::AppState::Recording => "recording",
        app_state::AppState::Finishing => "finishing",
    }
}

fn should_enable_escape_shortcut(state: &app_state::AppState) -> bool {
    matches!(
        state,
        app_state::AppState::Connecting
            | app_state::AppState::Recording
            | app_state::AppState::Finishing
    )
}

fn sync_escape_shortcut(app: &AppHandle, state: &app_state::AppState) {
    if let Some(hc) = app.try_state::<hotkey::HotkeyConfig>() {
        hotkey::set_escape_enabled(&hc, should_enable_escape_shortcut(state));
    }
}

async fn set_app_state(
    app: &AppHandle,
    app_inner: &Arc<app_state::AppInner>,
    next_state: app_state::AppState,
) {
    *app_inner.state.lock().await = next_state.clone();
    sync_escape_shortcut(app, &next_state);

    let _ = app.emit(
        "overlay:event",
        serde_json::json!({
            "type": "state",
            "payload": { "state": app_state_name(&next_state) }
        }),
    );
    log_rec!(info, "State → {}", app_state_name(&next_state));
}

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
    app_inner: &Arc<app_state::AppInner>,
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

/// Play a cue (`name` = "start" / "end") through the renderer's AudioContext
/// instead of spawning `afplay`. A freshly spawned `afplay` process competes with
/// the audio output device that is still settling, which attenuated the cue (low
/// volume) or cut it short (partial playback). The renderer plays it through a
/// dedicated, kept-warm AudioContext, so the cue is full-volume and never
/// truncated. Falls back to `afplay` only if the file cannot be read.
fn emit_cue(app: &AppHandle, app_inner: &Arc<app_state::AppInner>, name: &str) {
    let Some(file_path) = resolve_configured_sound_path(app, app_inner, name) else {
        return;
    };

    #[cfg(target_os = "macos")]
    {
        crate::paste::play_sound(&file_path);
    }

    #[cfg(not(target_os = "macos"))]
    match std::fs::read(&file_path) {
        Ok(bytes) => {
            use base64::Engine as _;
            let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
            let _ = app.emit(
                "overlay:event",
                serde_json::json!({
                    "type": "cue:play",
                    "payload": { "kind": name, "data": data }
                }),
            );
        }
        Err(error) => {
            log_app!(
                warn,
                "Cue '{}' read failed ({}), falling back to afplay: {}",
                name,
                file_path,
                error
            );
            crate::paste::play_sound(&file_path);
        }
    }
}

#[cfg(not(target_os = "macos"))]
async fn stop_renderer_audio(
    app: &AppHandle,
    app_inner: &Arc<app_state::AppInner>,
    timeout_ms: u64,
) {
    let (tx, rx) = tokio::sync::oneshot::channel();
    *app_inner.pending_audio_stop.lock().await = Some(tx);

    let _ = app.emit(
        "overlay:event",
        serde_json::json!({
            "type": "recording:stop",
        }),
    );

    if tokio::time::timeout(Duration::from_millis(timeout_ms), rx)
        .await
        .is_err()
    {
        let _ = app_inner.pending_audio_stop.lock().await.take();
    }
}

async fn stop_audio_capture(
    app: &AppHandle,
    app_inner: &Arc<app_state::AppInner>,
    timeout_ms: u64,
) {
    #[cfg(target_os = "macos")]
    {
        native_audio::stop_capture(app_inner).await;
        let _ = timeout_ms;
        let _ = app;
    }

    #[cfg(not(target_os = "macos"))]
    stop_renderer_audio(app, app_inner, timeout_ms).await;
}

async fn save_recording_wav(
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
    match write_wav_16k_mono(&path, &samples) {
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

fn write_wav_16k_mono(path: &std::path::Path, samples: &[f32]) -> Result<(), String> {
    const SAMPLE_RATE: u32 = 16_000;
    const CHANNELS: u16 = 1;
    const BYTES_PER_SAMPLE: u16 = 2;

    let data_bytes = samples.len() * BYTES_PER_SAMPLE as usize;
    let riff_size = 36usize
        .checked_add(data_bytes)
        .ok_or_else(|| "WAV too large".to_string())?;
    let mut wav = Vec::with_capacity(44 + data_bytes);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(riff_size as u32).to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&CHANNELS.to_le_bytes());
    wav.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    wav.extend_from_slice(&(SAMPLE_RATE * CHANNELS as u32 * BYTES_PER_SAMPLE as u32).to_le_bytes());
    wav.extend_from_slice(&(CHANNELS * BYTES_PER_SAMPLE).to_le_bytes());
    wav.extend_from_slice(&(BYTES_PER_SAMPLE * 8).to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&(data_bytes as u32).to_le_bytes());
    for &sample in samples {
        let pcm = (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        wav.extend_from_slice(&pcm.to_le_bytes());
    }

    std::fs::write(path, wav).map_err(|e| e.to_string())
}

async fn current_recording_wav_string(app_inner: &Arc<app_state::AppInner>) -> Option<String> {
    app_inner
        .current_recording_wav
        .lock()
        .await
        .as_ref()
        .map(|path| path.to_string_lossy().to_string())
}

async fn record_transcription_failure(
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
    set_overlay_retry_interaction(app, true);
    ts
}

fn prune_old_recordings(app: &AppHandle) {
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

/// Heuristic: did this recording capture actual sound (speech) rather than
/// silence? Used to tell a genuine no-speech stop (end immediately) apart from
/// speech whose transcript was lost to a slow/failed network (keep commit +
/// retry). Biased toward "has sound" so real speech is never silently dropped.
fn recording_has_audio_signal(samples: &[f32]) -> bool {
    // 16k mono. Native capture has no AEC, so the start cue bleeds into the mic
    // at the very beginning; skip that leading window so the cue is never mistaken
    // for speech. Anything the user actually says runs past it (and if they spoke
    // inside it, a transcript would have arrived, short-circuiting this check).
    const CUE_SKIP: usize = 11_200; // ~0.7s at 16k covers the start cue + echo tail
    const MIN_VOICE: usize = 1_600; // need ~100ms of real audio after the cue
    if samples.len() < CUE_SKIP + MIN_VOICE {
        return false;
    }
    let tail = &samples[CUE_SKIP..];
    let peak = tail.iter().fold(0.0f32, |m, &s| m.max(s.abs()));
    let rms = (tail.iter().map(|&s| s * s).sum::<f32>() / tail.len() as f32).sqrt();
    // A quiet mic noise floor sits well below these; speech clears both easily.
    peak >= 0.02 && rms >= 0.004
}

/// Drop the WAV and recording bookkeeping for a recording that produced nothing
/// worth keeping (e.g. the user stopped without speaking). Nothing to retry.
async fn discard_recording_artifacts(app_inner: &Arc<app_state::AppInner>) {
    if let Some(path) = app_inner.current_recording_wav.lock().await.take() {
        let _ = std::fs::remove_file(path);
    }
    *app_inner.current_retry_of.lock().await = None;
    *app_inner.current_failure_ts.lock().await = None;
    app_inner.recording_audio.lock().await.clear();
}

async fn record_success_and_apply_retention(
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

#[cfg(not(target_os = "macos"))]
async fn wait_for_audio_warmup(
    app_inner: &Arc<app_state::AppInner>,
    timeout_ms: u64,
) -> Result<(), String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    *app_inner.pending_audio_warmup.lock().await = Some(tx);

    match tokio::time::timeout(Duration::from_millis(timeout_ms), rx).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(_)) => Err("音频设备初始化失败".to_string()),
        Err(_) => {
            let _ = app_inner.pending_audio_warmup.lock().await.take();
            Err("音频设备初始化超时".to_string())
        }
    }
}

/// Show or hide the app in the macOS Dock.
#[cfg(target_os = "macos")]
fn set_dock_visible(visible: bool) {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy};
    if let Some(mtm) = MainThreadMarker::new() {
        let app = NSApplication::sharedApplication(mtm);
        let policy = if visible {
            NSApplicationActivationPolicy::Regular
        } else {
            NSApplicationActivationPolicy::Accessory
        };
        app.setActivationPolicy(policy);
    }
}

#[cfg(not(target_os = "macos"))]
fn set_dock_visible(_visible: bool) {}

/// Bring the settings window to front and show it in the Dock.
fn show_settings(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.show();
        let _ = window.set_focus();
        set_dock_visible(true);
    }
}

/// Setup the system tray icon with menu items.
fn setup_tray(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};

    let settings_item = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&settings_item, &separator, &quit_item])?;
    let icon = Image::from_bytes(include_bytes!("../icons/trayTemplate.png"))?;

    let tray = TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .icon_as_template(true)
        .tooltip("VoicePaste")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "settings" => {
                log_tray!(debug, "Settings clicked");
                show_settings(app);
            }
            "quit" => {
                log_tray!(debug, "Quit clicked");
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;

    // Keep the tray icon alive for the app's lifetime.
    app.manage(tray);

    Ok(())
}

/// Initialize keytap-based global hotkey listener.
fn setup_keytap_hotkeys(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    let app_inner: std::sync::Arc<app_state::AppInner> =
        (*app.state::<std::sync::Arc<app_state::AppInner>>()).clone();

    let config = app_inner
        .config_manager
        .load_config()
        .map_err(|e| e.to_string())?;
    let hotkey_str = match &config.app.hotkey {
        serde_norway::Value::String(s) => s.clone(),
        _ => String::new(),
    };
    let hotkey_mode = config.app.hotkey_mode.as_str();

    let prompts = app_inner.config_manager.load_prompts();
    let bindings = hotkey::build_initial_bindings(&hotkey_str, hotkey_mode, &prompts);

    let hotkey_config = hotkey::create_config(bindings);
    let hotkey_manager = hotkey::start_hotkey_listener(hotkey_config.clone(), app.handle().clone())
        .map_err(|e| format!("keytap init failed: {:?}", e))?;

    app.manage(hotkey_config);
    // Keep the manager alive for the app lifetime (its Drop stops the tap)
    app.manage(HotkeyManagerState {
        _inner: std::sync::Mutex::new(hotkey_manager),
    });

    Ok(())
}

/// Wrapper to keep the HotkeyManager alive as Tauri managed state.
/// The `_inner` field is intentionally never read — its purpose is to hold
/// ownership of the HotkeyManager so its Drop stops the keytap listener.
struct HotkeyManagerState {
    _inner: std::sync::Mutex<hotkey::HotkeyManager>,
}

/// Simple recording toggle state managed by Tauri.
struct RecordingState(std::sync::Mutex<bool>);

/// Hotkey mode: "toggle" (press once to start, press again to stop) or "hold" (hold to speak).
struct HotkeyMode(std::sync::Mutex<String>);

/// Tracks which prompt template triggered the current recording session.
/// `None` means the main hotkey was used (not a prompt-specific hotkey).
struct ActivePromptId(std::sync::Mutex<Option<String>>);

/// Handle hotkey press event. In toggle mode, toggles recording. In hold mode, starts recording.
/// `prompt_id` is `Some(id)` when a prompt-template hotkey was triggered, `None` for the main hotkey.
async fn on_hotkey_pressed(app_handle: AppHandle, mode: &str, prompt_id: Option<String>) {
    // Keyboard-driven retry: while a retryable failure is shown (idle, retry button
    // visible), the main hotkey triggers the retry instead of a new recording, so
    // the user can retry without reaching for the mouse.
    if prompt_id.is_none() {
        let app_inner = app_handle.state::<Arc<app_state::AppInner>>();
        let can_retry = matches!(*app_inner.state.lock().await, app_state::AppState::Idle)
            && app_inner.current_failure_ts.lock().await.is_some();
        if can_retry {
            let _ = retry_latest_failed_transcription(app_handle.clone()).await;
            return;
        }
    }

    // Store the active prompt ID for the recording session
    if let Some(active) = app_handle.try_state::<ActivePromptId>() {
        *active.0.lock().unwrap() = prompt_id;
    }

    if mode == "hold" {
        // Hold mode: press starts recording (only if not already recording)
        let recording_state = app_handle.state::<RecordingState>();
        let is_recording = *recording_state.0.lock().unwrap();
        if !is_recording {
            start_recording(app_handle).await;
        }
    } else {
        // Toggle mode: press toggles recording state
        toggle_recording(app_handle).await;
    }
}

/// Handle hotkey release event. In hold mode, stops recording. In toggle mode, does nothing.
async fn on_hotkey_released(app_handle: AppHandle, mode: &str) {
    if mode == "hold" {
        // Hold mode: release stops recording
        let recording_state = app_handle.state::<RecordingState>();
        let is_recording = *recording_state.0.lock().unwrap();
        if is_recording {
            stop_recording(app_handle).await;
        }
    }
    // Toggle mode: release is ignored
}

/// Start recording from idle state. Used by both toggle and hold modes.
async fn start_recording(app_handle: AppHandle) {
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
            let _ = app_handle.emit("overlay:event", serde_json::json!({
                "type": "hint",
                "payload": { "text": format!("配置加载失败: {}", e), "level": "error", "variant": "text" }
            }));
            return;
        }
    };

    // 1b. Pre-validate LLM config when a prompt-specific hotkey was used.
    //     Aborts early with an error hint instead of recording silently and
    //     producing no output.
    let active_prompt_id = app_handle
        .try_state::<ActivePromptId>()
        .and_then(|s| s.0.lock().unwrap().clone());

    if active_prompt_id.is_some() {
        if let Err(e) = crate::llm::validate_llm_config(&config.llm) {
            log_rec!(warn, "LLM pre-validation failed: {}", e);
            *recording_state.0.lock().unwrap() = false;
            // Show overlay with error, auto-hide after delay
            let _ = app_handle.emit("overlay:event", serde_json::json!({ "type": "reset" }));
            position_overlay(&app_handle);
            if let Some(overlay) = app_handle.get_webview_window("overlay") {
                let _ = overlay.show();
            }
            set_app_state(&app_handle, &app_inner, app_state::AppState::Idle).await;
            let _ = app_handle.emit(
                "overlay:event",
                serde_json::json!({
                    "type": "hint",
                    "payload": { "text": e, "level": "error", "variant": "text" }
                }),
            );
            // Auto-hide overlay after delay so user can read the error
            let delayed_handle = app_handle.clone();
            let delayed_inner: Arc<app_state::AppInner> = Arc::clone(&*app_inner);
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(3)).await;
                let still_idle = {
                    let s = delayed_inner.state.lock().await;
                    matches!(*s, app_state::AppState::Idle)
                };
                if still_idle {
                    if let Some(overlay) = delayed_handle.get_webview_window("overlay") {
                        let _ = overlay.hide();
                    }
                }
            });
            return;
        }
    }

    *app_inner.latest_transcript.lock().await = (String::new(), String::new());
    app_inner.recording_audio.lock().await.clear();
    *app_inner.current_recording_wav.lock().await = None;
    *app_inner.current_retry_of.lock().await = None;
    *app_inner.current_failure_ts.lock().await = None;
    set_overlay_retry_interaction(&app_handle, false);
    let _ = app_handle.emit("overlay:event", serde_json::json!({ "type": "reset" }));
    // Re-position before showing so the overlay follows the current display layout
    // (e.g. after an external monitor was connected/disconnected).
    position_overlay(&app_handle);
    if let Some(overlay) = app_handle.get_webview_window("overlay") {
        let _ = overlay.show();
    }

    // 2. Warm up microphone capture
    set_app_state(&app_handle, &app_inner, app_state::AppState::Connecting).await;
    #[cfg(target_os = "macos")]
    if let Err(e) = native_audio::start_capture(app_handle.clone(), Arc::clone(&app_inner)).await {
        *recording_state.0.lock().unwrap() = false;
        set_app_state(&app_handle, &app_inner, app_state::AppState::Idle).await;
        if let Some(overlay) = app_handle.get_webview_window("overlay") {
            let _ = overlay.hide();
        }
        log_rec!(warn, "Native audio warmup failed: {}", e);
        let _ = app_handle.emit(
            "overlay:event",
            serde_json::json!({
                "type": "hint",
                "payload": { "text": e, "level": "error", "variant": "text" }
            }),
        );
        return;
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app_handle.emit(
            "overlay:event",
            serde_json::json!({
                "type": "audio:warmup",
            }),
        );
        if let Err(e) = wait_for_audio_warmup(&app_inner, 8000).await {
            *recording_state.0.lock().unwrap() = false;
            stop_audio_capture(&app_handle, &app_inner, 1200).await;
            set_app_state(&app_handle, &app_inner, app_state::AppState::Idle).await;
            if let Some(overlay) = app_handle.get_webview_window("overlay") {
                let _ = overlay.hide();
            }
            log_rec!(warn, "Audio warmup failed: {}", e);
            let _ = app_handle.emit(
                "overlay:event",
                serde_json::json!({
                    "type": "hint",
                    "payload": { "text": e, "level": "error", "variant": "text" }
                }),
            );
            return;
        }
    }

    // Check if recording was cancelled during warmup (hold mode: quick press-release)
    if !*recording_state.0.lock().unwrap() {
        log_rec!(warn, "Cancelled during warmup, aborting start");
        stop_audio_capture(&app_handle, &app_inner, 1200).await;
        set_app_state(&app_handle, &app_inner, app_state::AppState::Idle).await;
        if let Some(overlay) = app_handle.get_webview_window("overlay") {
            let _ = overlay.hide();
        }
        return;
    }

    // Settle delay before the cue: the selected capture backend is live during
    // this wait (audio stays gated off until Recording), while the renderer's cue
    // keep-alive holds the output device warm so the start cue plays smoothly.
    // The cue is the user's "go" signal, so it lands after capture warmup.
    tokio::time::sleep(std::time::Duration::from_millis(AUDIO_SETTLE_MS)).await;

    // Re-check cancellation: the user may have released during the settle delay.
    if !*recording_state.0.lock().unwrap() {
        log_rec!(warn, "Cancelled during settle, aborting start");
        stop_audio_capture(&app_handle, &app_inner, 1200).await;
        set_app_state(&app_handle, &app_inner, app_state::AppState::Idle).await;
        if let Some(overlay) = app_handle.get_webview_window("overlay") {
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

    emit_cue(&app_handle, &app_inner, "start");
    set_app_state(&app_handle, &app_inner, app_state::AppState::Recording).await;
    #[cfg(not(target_os = "macos"))]
    let _ = app_handle.emit(
        "overlay:event",
        serde_json::json!({ "type": "recording:start" }),
    );

    // 5. Connect the ASR session in the background; attach it once ready.
    let connect_handle = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        connect_and_attach(connect_handle, config, hotwords, my_epoch, connect_tx).await;
    });
}

/// True while `my_epoch` is still the current recording session. A background
/// connect task uses this to detect that a cancel/restart has superseded it.
fn is_current_epoch(app_inner: &app_state::AppInner, my_epoch: u64) -> bool {
    app_inner
        .session_epoch
        .load(std::sync::atomic::Ordering::SeqCst)
        == my_epoch
}

/// Resolve the configured ASR engine and open a new session. Shared by the
/// initial background connect and the reconnect path. Returns the session, its
/// event receiver, and whether the overlay should show a static "recording" hint
/// (non-streaming engines produce no partial results).
async fn create_active_session(
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

    // Resolve engine from model ID: config.audio.provider stores the model ID.
    let engine_model_id = config.audio_provider();
    let entry = registry.models.iter().find(|m| m.id == engine_model_id);

    let (result, show_recording_hint) = match entry {
        Some(entry) if entry.engine == "sherpa-onnx" => {
            let punctuation_config = registry
                .models
                .iter()
                .find(|m| m.category == crate::model::ModelCategory::Punctuation)
                .and_then(|m| config.model_config_json(&m.id));
            let engine = crate::asr::sherpa_onnx::SherpaOnnxEngine::new(
                crate::asr::sherpa_onnx::SherpaOnnxEngineOptions {
                    data_dir,
                    resource_dir,
                    active_model_id: engine_model_id.to_string(),
                    vad_params: config.vad_params(&registry),
                    global_config: config.asr_defaults_json(&registry),
                    model_config: config.model_config_json(engine_model_id),
                    punctuation_config,
                    stream_simulate: config.stream_simulate(engine_model_id, &registry),
                },
            );
            // Non-streaming engines without simulated streaming produce no partials.
            let show_hint = !entry.capabilities.streaming
                && !config.stream_simulate(engine_model_id, &registry);
            (engine.create_session(hotwords).await, show_hint)
        }
        _ => {
            // Default / volcengine: Doubao online engine
            let doubao_config = config.doubao_streaming_config(&registry);
            let engine = crate::asr::doubao::DoubaoEngine::new(
                doubao_config.to_connection_config(),
                doubao_config.to_audio_config(),
                doubao_config.to_request_config(),
            );
            (engine.create_session(hotwords).await, false)
        }
    };

    result.map(|(session, event_rx)| (session, event_rx, show_recording_hint))
}

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
        current_recording_wav_string(app_inner).await,
        Some(ts.to_string()),
    );
    *app_inner.current_failure_ts.lock().await = Some(failure_ts);
    emit_retryable_error_hint(app_handle, app_inner, message).await;
    set_overlay_retry_interaction(app_handle, true);
    set_app_state(app_handle, app_inner, app_state::AppState::Idle).await;
    schedule_retry_overlay_hide(app_handle.clone(), Arc::clone(app_inner));
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
    let samples = read_wav_16k_mono(&path)?;
    if samples.is_empty() {
        return Err("录音文件为空，无法重试".to_string());
    }

    set_overlay_retry_interaction(&app_handle, false);
    set_app_state(&app_handle, &app_inner, app_state::AppState::Finishing).await;
    // Clear the stale failure hint + old transcript, then show a "retrying"
    // placeholder while the connection is established. The overlay yields this
    // placeholder to the live transcript the moment the replayed recognition
    // starts streaming in (see visible_hint / getVisibleHintText), so the user
    // sees "重试中" → streaming text, like a normal recording.
    let _ = app_handle.emit("overlay:event", serde_json::json!({ "type": "reset" }));
    let _ = app_handle.emit(
        "overlay:event",
        serde_json::json!({
            "type": "hint",
            "payload": { "text": "", "level": "info", "variant": "retry" }
        }),
    );
    *app_inner.latest_transcript.lock().await = (String::new(), String::new());
    *app_inner.current_recording_wav.lock().await = Some(path);
    *app_inner.current_retry_of.lock().await = Some(ts.clone());

    let config = app_inner.config_manager.load_config()?;
    let hotwords = app_inner.hotword_manager.active_words();
    let (session, event_rx, _) = match create_active_session(&app_handle, &config, &hotwords).await
    {
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
        manage_asr_session(events_app, event_rx, retry_epoch).await;
    });

    for chunk in samples.chunks(1600) {
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
    tokio::time::sleep(Duration::from_millis(150)).await;
    finalize_and_paste(&app_handle, &app_inner, text.clone()).await;
    session.close();
    *app_inner.current_failure_ts.lock().await = None;
    set_app_state(&app_handle, &app_inner, app_state::AppState::Idle).await;
    if let Some(overlay) = app_handle.get_webview_window("overlay") {
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

fn read_wav_16k_mono(path: &std::path::Path) -> Result<Vec<f32>, String> {
    let data = std::fs::read(path).map_err(|e| format!("读取录音文件失败: {e}"))?;
    if data.len() < 44 || &data[0..4] != b"RIFF" || &data[8..12] != b"WAVE" {
        return Err("录音文件不是有效 WAV".to_string());
    }
    let mut pos = 12usize;
    let mut channels = 0u16;
    let mut sample_rate = 0u32;
    let mut bits = 0u16;
    let mut data_range = None;
    while pos + 8 <= data.len() {
        let id = &data[pos..pos + 4];
        let size = u32::from_le_bytes([data[pos + 4], data[pos + 5], data[pos + 6], data[pos + 7]])
            as usize;
        let start = pos + 8;
        let end = start.saturating_add(size).min(data.len());
        if id == b"fmt " && size >= 16 && end <= data.len() {
            channels = u16::from_le_bytes([data[start + 2], data[start + 3]]);
            sample_rate = u32::from_le_bytes([
                data[start + 4],
                data[start + 5],
                data[start + 6],
                data[start + 7],
            ]);
            bits = u16::from_le_bytes([data[start + 14], data[start + 15]]);
        } else if id == b"data" {
            data_range = Some(start..end);
            break;
        }
        pos = start + size + (size % 2);
    }
    if channels != 1 || sample_rate != 16_000 || bits != 16 {
        return Err("仅支持 16kHz mono 16-bit WAV 重试".to_string());
    }
    let range = data_range.ok_or_else(|| "WAV 缺少 data chunk".to_string())?;
    Ok(data[range]
        .chunks_exact(2)
        .map(|chunk| i16::from_le_bytes([chunk[0], chunk[1]]) as f32 / 32768.0)
        .collect())
}

/// Connect the ASR session in the background (one retry), then attach it: flush
/// any audio buffered during the connect and publish the ready session. Signals
/// completion through `connect_tx` so `stop_recording` can wait when the user
/// stops before the session is ready.
async fn connect_and_attach(
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
                let _ = app_handle.emit(
                    "overlay:event",
                    serde_json::json!({
                        "type": "hint",
                        "payload": { "text": "录制中…", "level": "info", "variant": "recording" }
                    }),
                );
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
            app_inner.pending_audio.lock().await.clear();
            stop_audio_capture(&app_handle, &app_inner, 1200).await;
            save_recording_wav(&app_handle, &app_inner).await;
            let message = format!("ASR 连接失败: {}，请检查网络连接", e);
            record_transcription_failure(&app_handle, &app_inner, &message).await;
            // Emit error hint BEFORE setting idle so the overlay shows it: the
            // frontend's idle handler only clears "info"-level hints.
            emit_retryable_error_hint(&app_handle, &app_inner, &message).await;
            set_app_state(&app_handle, &app_inner, app_state::AppState::Idle).await;
            // Auto-hide after a delay so the user can read it; guard: still idle.
            schedule_retry_overlay_hide(app_handle.clone(), Arc::clone(&app_inner));
        }
    }
}

/// Stop recording and finalize (paste text). Used by both toggle and hold modes.
async fn stop_recording(app_handle: AppHandle) {
    let app_inner = app_handle.state::<Arc<app_state::AppInner>>();
    let recording_state = app_handle.state::<RecordingState>();

    // Mark as not recording
    *recording_state.0.lock().unwrap() = false;

    // 1. Set state to finishing
    set_app_state(&app_handle, &app_inner, app_state::AppState::Finishing).await;

    // 2. Stop renderer audio first so the final buffered chunk is flushed.
    stop_audio_capture(&app_handle, &app_inner, 1200).await;
    // Snapshot whether real sound was captured before save_recording_wav drains
    // the buffer: a silent stop ends immediately, but speech whose transcript was
    // lost (slow/failed network) must keep the retry path even with no result yet.
    let captured_audio_signal = {
        let audio = app_inner.recording_audio.lock().await;
        recording_has_audio_signal(&audio)
    };
    save_recording_wav(&app_handle, &app_inner).await;

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
                    discard_recording_artifacts(&app_inner).await;
                    set_overlay_retry_interaction(&app_handle, false);
                    if let Some(overlay) = app_handle.get_webview_window("overlay") {
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
            discard_recording_artifacts(&app_inner).await;
            set_overlay_retry_interaction(&app_handle, false);
            if let Some(overlay) = app_handle.get_webview_window("overlay") {
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
                record_transcription_failure(&app_handle, &app_inner, &e).await;
                emit_retryable_error_hint(&app_handle, &app_inner, &e).await;
                set_app_state(&app_handle, &app_inner, app_state::AppState::Idle).await;
                schedule_retry_overlay_hide(app_handle.clone(), Arc::clone(&app_inner));
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
        finalize_and_paste(&app_handle, &app_inner, combined).await;

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
            finalize_and_paste(&app_handle, &app_inner, prefix).await;
        } else {
            log_rec!(
                warn,
                "Stop with no ready ASR session; discarding buffered audio"
            );
            let message = "语音服务连接失败，请检查网络连接";
            record_transcription_failure(&app_handle, &app_inner, message).await;
            emit_retryable_error_hint(&app_handle, &app_inner, message).await;
            *app_inner.accumulated_text.lock().await = String::new();
            set_app_state(&app_handle, &app_inner, app_state::AppState::Idle).await;
            schedule_retry_overlay_hide(app_handle.clone(), Arc::clone(&app_inner));
            return;
        }
    }

    // 11. Clear cross-reconnect accumulated text for the next recording.
    *app_inner.accumulated_text.lock().await = String::new();

    // 12. Hide overlay
    set_overlay_retry_interaction(&app_handle, false);
    if let Some(overlay) = app_handle.get_webview_window("overlay") {
        let _ = overlay.hide();
    }

    // 13. Set state back to idle
    set_app_state(&app_handle, &app_inner, app_state::AppState::Idle).await;
}

/// Toggle the recording state: if idle, start recording; if recording, stop.
/// Used by toggle-mode hotkey handlers.
pub async fn toggle_recording(app_handle: AppHandle) {
    let recording_state = app_handle.state::<RecordingState>();
    let is_recording = {
        let mut recording = recording_state.0.lock().unwrap();
        *recording = !*recording;
        *recording
    };

    if is_recording {
        start_recording(app_handle).await;
    } else {
        stop_recording(app_handle).await;
    }
}

/// Cancel the active recording without committing or pasting text.
/// Directly toggle the ESC-cancel shortcut, independent of the recording state
/// machine. Used to keep ESC live while a retryable failure is shown (idle).
fn set_escape_enabled_now(app: &AppHandle, enabled: bool) {
    if let Some(hc) = app.try_state::<hotkey::HotkeyConfig>() {
        hotkey::set_escape_enabled(&hc, enabled);
    }
}

/// ESC handler. Routes to the right teardown for whatever is on screen:
/// an active recording, an in-flight retry, or a shown retryable failure.
pub(crate) async fn on_escape(app_handle: AppHandle) {
    if is_recording(&app_handle) {
        cancel_recording(app_handle).await;
        return;
    }
    let app_inner = app_handle.state::<Arc<app_state::AppInner>>();
    let state = app_inner.state.lock().await.clone();
    match state {
        // Retry in progress (a normal commit has no retry marker): abort it.
        app_state::AppState::Finishing if app_inner.current_retry_of.lock().await.is_some() => {
            abort_retry_or_failure(&app_handle, &app_inner).await;
        }
        // Retryable failure currently shown: dismiss it.
        app_state::AppState::Idle if app_inner.current_failure_ts.lock().await.is_some() => {
            abort_retry_or_failure(&app_handle, &app_inner).await;
        }
        _ => {}
    }
}

/// Tear down an in-flight retry or a shown retryable failure: discard any
/// in-flight result via the epoch bump, clear retry state, and hide the overlay.
async fn abort_retry_or_failure(app_handle: &AppHandle, app_inner: &Arc<app_state::AppInner>) {
    app_inner
        .session_epoch
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    *app_inner.current_retry_of.lock().await = None;
    *app_inner.current_failure_ts.lock().await = None;
    *app_inner.latest_transcript.lock().await = (String::new(), String::new());
    *app_inner.accumulated_text.lock().await = String::new();
    set_overlay_retry_interaction(app_handle, false);
    let _ = app_handle.emit("overlay:event", serde_json::json!({ "type": "reset" }));
    if let Some(overlay) = app_handle.get_webview_window("overlay") {
        let _ = overlay.hide();
    }
    // set_app_state(Idle) also re-syncs (disables) the ESC shortcut.
    set_app_state(app_handle, app_inner, app_state::AppState::Idle).await;
}

async fn cancel_recording(app_handle: AppHandle) {
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

    stop_audio_capture(&app_handle, &app_inner, 1200).await;

    if let Some(session) = app_inner.asr_session.lock().await.take() {
        session.close();
    }
    *app_inner.asr_events.lock().await = None;
    *app_inner.latest_transcript.lock().await = (String::new(), String::new());
    *app_inner.accumulated_text.lock().await = String::new();

    let _ = app_handle.emit("overlay:event", serde_json::json!({ "type": "reset" }));
    if let Some(overlay) = app_handle.get_webview_window("overlay") {
        let _ = overlay.hide();
    }
    set_app_state(&app_handle, &app_inner, app_state::AppState::Idle).await;
}

/// Default system prompt for LLM text structuring.
const DEFAULT_STRUCTURE_PROMPT: &str = "整理语音转写内容，仅输出最终文本，不附加其他内容。\n- 删除语气词、重复内容及多余口语词汇\n- 理顺语序，保证逻辑流畅\n- 修正识别错误，还原正确词汇与专有名词\n- 忠于原意，不新增、改动信息\n- 篇幅较长则使用列表结构化呈现，短句不作格式调整";

/// Maximum number of consecutive ASR reconnect attempts before giving up and
/// finalizing the recording with whatever text was recognized so far. Reset to
/// zero each time the reconnected session produces a fresh transcript.
const MAX_ASR_RECONNECT: u32 = 3;

/// Read the current recording flag without holding the lock across await points.
fn is_recording(app: &AppHandle) -> bool {
    app.try_state::<RecordingState>()
        .map(|state| *state.0.lock().unwrap())
        .unwrap_or(false)
}

/// True while this manager's recording session is still the active, current one
/// (not stopped, cancelled, or superseded by a restart).
fn session_is_active(app: &AppHandle, app_inner: &app_state::AppInner, my_epoch: u64) -> bool {
    is_recording(app) && is_current_epoch(app_inner, my_epoch)
}

/// Snapshot the best text recognized in the current session from shared state.
/// `manage_asr_session` stores every transcript here, so it serves as the
/// carry-over source across a reconnect and the salvage source on failure.
async fn current_session_text(app_inner: &app_state::AppInner) -> String {
    let (final_t, partial_t) = app_inner.latest_transcript.lock().await.clone();
    if !final_t.is_empty() {
        final_t
    } else {
        partial_t
    }
}

/// Manage an ASR session for the duration of a recording: forward transcripts to
/// the overlay, and on a recoverable error/close, auto-reconnect a fresh session
/// (carrying already-recognized text). On a fatal error or after reconnects are
/// exhausted, finalize the recording with the accumulated text instead of
/// discarding it.
async fn manage_asr_session(
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
                    finalize_on_failure(&app, &app_inner, &message).await;
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
                    finalize_on_failure(&app, &app_inner, "ASR 连接已断开").await;
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
    let _ = app.emit(
        "overlay:event",
        serde_json::json!({
            "type": "hint",
            "payload": { "text": "网络中断，正在重连…", "level": "warn", "variant": "text" }
        }),
    );

    // Play the end cue on the first reconnect attempt so the user audibly knows
    // recording was interrupted and can stop talking until they hear it resume.
    if *attempts == 1 {
        emit_cue(app, app_inner, "end");
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
    tokio::time::sleep(Duration::from_millis(300)).await;

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
            let _ = app.emit(
                "overlay:event",
                serde_json::json!({
                    "type": "hint",
                    "payload": { "text": "已重连", "level": "info", "variant": "text" }
                }),
            );
            // Play the start cue so the user audibly knows recording resumed.
            emit_cue(app, app_inner, "start");
            Some(event_rx)
        }
        Err(e) => {
            log_events!(error, "ASR reconnect failed: {}", e);
            None
        }
    }
}

/// Finalize a recording that failed mid-stream (fatal error or exhausted
/// reconnects): salvage the accumulated text plus the current session's text and
/// run it through the normal paste pipeline, then tear down and hide the overlay.
async fn finalize_on_failure(app: &AppHandle, app_inner: &Arc<app_state::AppInner>, message: &str) {
    // Stop recording so audio routing and hotkey toggling settle.
    if let Some(state) = app.try_state::<RecordingState>() {
        *state.0.lock().unwrap() = false;
    }

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

    stop_audio_capture(app, app_inner, 1200).await;
    save_recording_wav(app, app_inner).await;

    if combined.trim().is_empty() {
        record_transcription_failure(app, app_inner, message).await;
        // Nothing to salvage: surface the error so the user understands the abort.
        log_events!(warn, "ASR failed with no recognized text: {}", message);
        emit_retryable_error_hint(app, app_inner, message).await;
        if let Some(active) = app.try_state::<ActivePromptId>() {
            *active.0.lock().unwrap() = None;
        }
        set_app_state(app, app_inner, app_state::AppState::Idle).await;
        schedule_retry_overlay_hide(app.clone(), Arc::clone(app_inner));
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

    if let Some(overlay) = app.get_webview_window("overlay") {
        let _ = overlay.hide();
    }
    set_app_state(app, app_inner, app_state::AppState::Idle).await;
}

/// Run recognized text through the finishing pipeline: optional LLM polishing
/// (prompt-specific hotkeys only, with sherpa-onnx hotword hinting), trailing-
/// period trimming, clipboard write (honoring keep_clipboard), simulated paste,
/// usage stats, and the end cue. Shared by the normal stop path and the
/// failure-salvage path.
async fn finalize_and_paste(
    app_handle: &AppHandle,
    app_inner: &Arc<app_state::AppInner>,
    raw_text: String,
) {
    let trimmed = raw_text.trim().to_string();

    // Always clear the active prompt ID once a recording concludes.
    let active_prompt_id = app_handle
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
                trimmed =
                    crate::asr::sherpa_onnx::online::restore_hotword_case(&trimmed, &hotwords);
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
    let final_text = if let Some(ref config) = config {
        if active_prompt_id.is_some() {
            let prompts = app_inner.config_manager.load_prompts();
            let mut system_prompt = active_prompt_id
                .as_ref()
                .and_then(|pid| {
                    prompts
                        .iter()
                        .find(|p| &p.id == pid)
                        .map(|p| p.prompt.clone())
                        .filter(|p| !p.trim().is_empty())
                })
                .unwrap_or_else(|| DEFAULT_STRUCTURE_PROMPT.to_string());

            // Append hotwords to the LLM prompt as a proper-noun hint, per the
            // model's hotword_llm_mode ("disabled" / "force" / auto = only when the
            // engine itself lacks hotword support).
            let model_id = config.audio_provider();
            let append_hotwords = match config.hotword_llm_mode(model_id, &registry).as_str() {
                "disabled" => false,
                "force" => true,
                _ => registry
                    .models
                    .iter()
                    .find(|m| m.id == model_id)
                    .map(|m| !m.capabilities.hotwords)
                    .unwrap_or(false),
            };
            if append_hotwords {
                let hw: Vec<String> = app_inner
                    .hotword_manager
                    .active_words()
                    .iter()
                    .map(|w| crate::hotword::strip_weight(w).to_string())
                    .collect();
                if !hw.is_empty() {
                    system_prompt = format!(
                        "{}\n\n需要注意以下专有名词的准确拼写：{}",
                        system_prompt,
                        hw.join("、")
                    );
                }
            }

            log_rec!(
                debug,
                "Applying LLM structure_text (prompt_id: {:?})",
                active_prompt_id
            );
            match crate::llm::call_llm_api(&config.llm, &trimmed, &system_prompt).await {
                Ok(result) => {
                    log_rec!(
                        info,
                        "LLM polishing succeeded ({} chars)",
                        result.chars().count()
                    );
                    log_rec!(
                        debug,
                        "LLM polished preview: {:?}",
                        result.chars().take(200).collect::<String>()
                    );
                    result
                }
                Err(e) => {
                    log_rec!(warn, "LLM polishing failed: {}, using raw text", e);
                    let _ = app_handle.emit("overlay:event", serde_json::json!({
                        "type": "hint",
                        "payload": { "text": "文本润色失败，已输出原文", "level": "warn", "variant": "text" }
                    }));
                    trimmed.clone()
                }
            }
        } else {
            trimmed.clone()
        }
    } else {
        trimmed.clone()
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
        let _ = app_handle.emit("overlay:event", serde_json::json!({
            "type": "hint",
            "payload": { "text": format!("剪贴板写入失败: {}", e), "level": "error", "variant": "text" }
        }));
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
    record_success_and_apply_retention(app_handle, app_inner, &final_text, keep_recordings).await;
    emit_cue(app_handle, app_inner, "end");
}

/// Reload all hotkey bindings from the current config and prompts.
/// Called after saving config or prompts so changes take effect immediately.
pub fn reload_hotkey_bindings(app: &AppHandle) {
    let Some(hc) = app.try_state::<hotkey::HotkeyConfig>() else {
        log_hotkey!(error, "HotkeyConfig not in managed state");
        return;
    };

    let app_inner = app.state::<std::sync::Arc<app_state::AppInner>>();
    let config = match app_inner.config_manager.load_config() {
        Ok(c) => c,
        Err(e) => {
            log_hotkey!(error, "Failed to load config for reload: {}", e);
            return;
        }
    };

    let hotkey_str = match &config.app.hotkey {
        serde_norway::Value::String(s) => s.clone(),
        _ => String::new(),
    };

    let mode = app
        .try_state::<HotkeyMode>()
        .map(|m| m.0.lock().unwrap().clone())
        .unwrap_or_else(|| "toggle".to_string());

    let prompts = app_inner.config_manager.load_prompts();
    hotkey::reload_bindings(&hc, &hotkey_str, &mode, &prompts);
}

#[cfg(test)]
mod audio_signal_tests {
    use super::recording_has_audio_signal;

    #[test]
    fn silence_is_not_treated_as_speech() {
        let silence = vec![0.0f32; 16_000];
        assert!(!recording_has_audio_signal(&silence));
    }

    #[test]
    fn quiet_noise_floor_is_not_treated_as_speech() {
        // ~ -54 dBFS hum: below both gates, must not look like speech.
        let noise: Vec<f32> = (0..16_000)
            .map(|i| if i % 2 == 0 { 0.002 } else { -0.002 })
            .collect();
        assert!(!recording_has_audio_signal(&noise));
    }

    #[test]
    fn very_short_clip_is_not_treated_as_speech() {
        // Under 100ms even at full amplitude is an accidental tap, not speech.
        let blip = vec![0.5f32; 800];
        assert!(!recording_has_audio_signal(&blip));
    }

    #[test]
    fn loud_sustained_signal_is_treated_as_speech() {
        // A 0.3-amplitude tone clears both the peak and RMS gates.
        let tone: Vec<f32> = (0..16_000).map(|i| 0.3 * (i as f32 * 0.2).sin()).collect();
        assert!(recording_has_audio_signal(&tone));
    }

    #[test]
    fn start_cue_bleed_then_silence_is_not_treated_as_speech() {
        // Loud cue in the first ~0.5s, silence afterward: must be skipped, not
        // mistaken for the user speaking (no AEC in native capture).
        let mut samples = vec![0.0f32; 16_000];
        for (i, s) in samples.iter_mut().enumerate().take(8_000) {
            *s = 0.4 * (i as f32 * 0.3).sin();
        }
        assert!(!recording_has_audio_signal(&samples));
    }
}

#[cfg(test)]
mod hotkey_label_tests {
    use super::format_hotkey_label;

    #[test]
    fn function_key_passes_through() {
        assert_eq!(format_hotkey_label("F13"), "F13");
    }

    #[test]
    fn sided_modifier_matches_settings_symbol() {
        // Mirrors the frontend normalizeHotkeyLabel ("AltRight" -> "R ⌥").
        assert_eq!(format_hotkey_label("AltRight"), "R ⌥");
    }

    #[test]
    fn combo_is_symbolized_and_joined() {
        assert_eq!(format_hotkey_label("Control+Space"), "⌃ ␣");
        assert_eq!(format_hotkey_label("CmdOrCtrl+Shift+A"), "⌘ ⇧ A");
    }

    #[test]
    fn empty_stays_empty() {
        assert_eq!(format_hotkey_label(""), "");
    }
}
