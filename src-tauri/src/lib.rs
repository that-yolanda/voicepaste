#[macro_use]
mod logger;
mod app_state;
mod asr;
mod commands;
mod config;
mod hotkey;
mod hotword;
mod model;
mod llm;
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
    image::Image,
    tray::TrayIconBuilder,
    App, AppHandle, Emitter, Listener, Manager, RunEvent,
};

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
            model::ensure_registry(&data_dir, &resource_dir);

            // Initialize services
            let config_manager = config::ConfigManager::new(&data_dir, &resource_dir);
            let log_path = data_dir.join("voicepaste.log");
            let stats_service = stats::StatsService::new(&data_dir);
            let hotword_manager = hotword::HotwordManager::new(&data_dir, &resource_dir);

            // Import configured Doubao hotwords into hotwords.json (one-time bootstrap)
            if let Ok(cfg) = config_manager.load_config() {
                if let Some(corpus) = &cfg.doubao_streaming_config().corpus {
                    if let Some(hw) = corpus.get("context_hotwords").and_then(|v| v.as_str()) {
                        if !hw.is_empty() {
                            let _ = hotword_manager.import_from_legacy(hw);
                        }
                    }
                }
            }

            // Initialize global logger (must be before any log_*! calls)
            let voice_logger = logger::VoiceLogger::new(log_path.clone());
            let log_level = if cfg!(debug_assertions) {
                log::LevelFilter::Debug
            } else {
                log::LevelFilter::Info
            };
            log::set_boxed_logger(Box::new(voice_logger))
                .expect("Failed to set global logger");
            log::set_max_level(log_level);

            // Read hotkey mode before config_manager is moved into app state
            let hotkey_mode = config_manager
                .load_config()
                .map(|c| c.app.hotkey_mode.clone())
                .unwrap_or_else(|_| "toggle".to_string());

            let app_state = create_app_state(config_manager, hotword_manager, log_path, stats_service);
            app.manage(app_state);

            // Recording state toggle (used by global shortcut handler)
            app.manage(RecordingState(std::sync::Mutex::new(false)));

            // Hotkey mode: "toggle" or "hold"
            app.manage(HotkeyMode(std::sync::Mutex::new(hotkey_mode)));

            // Active prompt ID for the current recording session (None = main hotkey)
            app.manage(ActivePromptId(std::sync::Mutex::new(None)));

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
            commands::get_settings_data,
            commands::save_config_object,
            commands::load_prompts,
            commands::save_prompts,
            commands::get_stats,
            commands::get_history,
            commands::delete_history,
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
            RunEvent::ExitRequested { code, api, .. } => {
                // Keep the app running in the tray for user-initiated window closes,
                // but allow tray "quit" to call app.exit(0).
                if code.is_none() {
                    api.prevent_exit();
                }
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
            let _ = overlay.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(
                x, y,
            )));
        }
    }
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

    if next_state == app_state::AppState::Recording {
        play_configured_sound(app, app_inner, "start");
    }

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

fn play_configured_sound(app: &AppHandle, app_inner: &Arc<app_state::AppInner>, name: &str) {
    let config = match app_inner.config_manager.load_config() {
        Ok(config) => config,
        Err(error) => {
            log_app!(warn, "Sound config load failed: {}", error);
            return;
        }
    };

    let sound_config = config.app.sound.as_ref();
    if sound_config.map(|sound| !sound.enabled).unwrap_or(false) {
        return;
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

    crate::paste::play_sound(&file_path);
}

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

    let config = app_inner.config_manager.load_config().map_err(|e| format!("{}", e))?;
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
            let _ = app_handle.emit("overlay:event", serde_json::json!({
                "type": "hint",
                "payload": { "text": e, "level": "error", "variant": "text" }
            }));
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
    let _ = app_handle.emit("overlay:event", serde_json::json!({ "type": "reset" }));
    // Re-position before showing so the overlay follows the current display layout
    // (e.g. after an external monitor was connected/disconnected).
    position_overlay(&app_handle);
    if let Some(overlay) = app_handle.get_webview_window("overlay") {
        let _ = overlay.show();
    }

    // 2. Warm up microphone capture
    set_app_state(&app_handle, &app_inner, app_state::AppState::Connecting).await;
    let _ = app_handle.emit(
        "overlay:event",
        serde_json::json!({
            "type": "audio:warmup",
        }),
    );
    if let Err(e) = wait_for_audio_warmup(&app_inner, 8000).await {
        *recording_state.0.lock().unwrap() = false;
        stop_renderer_audio(&app_handle, &app_inner, 1200).await;
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

    // Check if recording was cancelled during warmup (hold mode: quick press-release)
    if !*recording_state.0.lock().unwrap() {
        log_rec!(warn, "Cancelled during warmup, aborting start");
        stop_renderer_audio(&app_handle, &app_inner, 1200).await;
        set_app_state(&app_handle, &app_inner, app_state::AppState::Idle).await;
        if let Some(overlay) = app_handle.get_webview_window("overlay") {
            let _ = overlay.hide();
        }
        return;
    }

    // 3. Create ASR session (engine chosen by model ID → registry engine)
    let hotwords = app_inner.hotword_manager.active_words();
    log_rec!(debug, "Active hotwords ({}): {:?}", hotwords.len(), hotwords);

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

    let result = match entry {
        Some(entry) if entry.engine == "sherpa-onnx" => {
            let engine = crate::asr::sherpa_onnx::SherpaOnnxEngine::new(
                data_dir,
                resource_dir,
                engine_model_id.to_string(),
                config.vad_params(),
                config.model_config_json(engine_model_id),
                config.stream_simulate(),
            );
            engine.create_session(&hotwords).await
        }
        _ => {
            // Default / volcengine: Doubao online engine
            let doubao_config = config.doubao_streaming_config();
            let engine = crate::asr::doubao::DoubaoEngine::new(
                doubao_config.to_connection_config(),
                doubao_config.to_audio_config(),
                doubao_config.to_request_config(),
            );
            engine.create_session(&hotwords).await
        }
    };

    match result {
        Ok((session, event_rx)) => {
            let session: Arc<dyn crate::asr::AsrSession> = Arc::from(session);

            // Check if recording was cancelled during ASR connection
            if !*recording_state.0.lock().unwrap() {
                log_rec!(warn, "Cancelled during ASR connection, closing session");
                session.close();
                stop_renderer_audio(&app_handle, &app_inner, 1200).await;
                set_app_state(&app_handle, &app_inner, app_state::AppState::Idle).await;
                if let Some(overlay) = app_handle.get_webview_window("overlay") {
                    let _ = overlay.hide();
                }
                return;
            }

            *app_inner.asr_session.lock().await = Some(session);
            set_app_state(&app_handle, &app_inner, app_state::AppState::Recording).await;

            let _ = app_handle.emit(
                "overlay:event",
                serde_json::json!({
                    "type": "recording:start",
                }),
            );

            // For non-streaming engines without simulated streaming,
            // show a "recording" hint since partial results won't appear.
            if entry.map_or(false, |e| !e.capabilities.streaming)
                && !config.stream_simulate()
            {
                let _ = app_handle.emit(
                    "overlay:event",
                    serde_json::json!({
                        "type": "hint",
                        "payload": { "text": "录制中…", "level": "info", "variant": "recording" }
                    }),
                );
            }

            let app_for_events = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                forward_asr_events(app_for_events, event_rx).await;
            });
        }
        Err(e) => {
            log_rec!(error, "ASR connection failed: {}", e);
            *recording_state.0.lock().unwrap() = false;
            stop_renderer_audio(&app_handle, &app_inner, 1200).await;
            // Emit error hint BEFORE setting idle state so the overlay shows the
            // error message.  The state:idle handler in the frontend only clears
            // hints whose level is "info", so an "error" level hint survives.
            let _ = app_handle.emit("overlay:event", serde_json::json!({
                "type": "hint",
                "payload": { "text": format!("ASR 连接失败: {}", e), "level": "error", "variant": "text" }
            }));
            set_app_state(&app_handle, &app_inner, app_state::AppState::Idle).await;
            // Auto-hide the overlay after a short delay so the user can read the
            // error.  Guard: only hide if still idle (not in a new session).
            let delayed_handle = app_handle.clone();
            let delayed_inner: Arc<app_state::AppInner> =
                Arc::clone(&*app_inner);
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
    stop_renderer_audio(&app_handle, &app_inner, 1200).await;

    // 3. Take the ASR session (removes it from state)
    let session = app_inner.asr_session.lock().await.take();
    *app_inner.asr_events.lock().await = None;

    if let Some(session) = session {
        // 4. Commit and get final text
        let text = match session.commit_and_await_final().await {
            Ok(t) => t,
            Err(_) => {
                let (final_t, partial_t) = app_inner.latest_transcript.lock().await.clone();
                if !final_t.is_empty() {
                    final_t
                } else {
                    partial_t
                }
            }
        };

        let mut trimmed = text.trim().to_string();
        if !trimmed.is_empty() {
            log_rec!(info, "Final text received ({} chars)", trimmed.chars().count());
            log_rec!(debug, "Final text preview: {:?}", trimmed.chars().take(60).collect::<String>());

            // 5. Load config for LLM / behavior settings
            let config = app_inner.config_manager.load_config().ok();

            // Note: hotword case restoration is now handled inside
            // OnlineSession::commit_and_await_final — no external
            // post-processing needed here.
            if config
                .as_ref()
                .map(|config| config.app.remove_trailing_period)
                .unwrap_or(true)
                && (trimmed.ends_with('。') || trimmed.ends_with('.'))
            {
                trimmed.pop();
            }

            // 6. Apply LLM structure_text only when a prompt-specific hotkey was used.
            // The main hotkey (active_prompt_id = None) pastes raw text without polishing.
            let active_prompt_id = app_handle
                .try_state::<ActivePromptId>()
                .and_then(|s| s.0.lock().unwrap().clone());

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

                    // When using sherpa-onnx (local) engine, append hotwords to the LLM prompt
                    // as a fallback hint for proper-noun accuracy.
                    if config.audio_provider().starts_with("sherpa-onnx") {
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

                    log_rec!(debug, "Applying LLM structure_text (prompt_id: {:?})", active_prompt_id);
                    match crate::llm::call_llm_api(&config.llm, &trimmed, &system_prompt).await {
                        Ok(result) => {
                            log_rec!(info, "LLM polishing succeeded ({} chars)", result.chars().count());
                            result
                        }
                        Err(e) => {
                            log_rec!(warn, "LLM polishing failed: {}, using raw text", e);
                            let _ = app_handle.emit("overlay:event", serde_json::json!({
                                "type": "hint",
                                "payload": { "text": format!("文本润色失败，已输出原文"), "level": "warn", "variant": "text" }
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

            // Clear the active prompt ID after use
            if let Some(active) = app_handle.try_state::<ActivePromptId>() {
                *active.0.lock().unwrap() = None;
            }

            // 7. Write to clipboard
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

            // 8. Simulate paste keystroke
            let _result = crate::paste::simulate_paste();

            // Restore original clipboard content if keep_clipboard is disabled
            if let Some(original) = original_clipboard {
                if let Err(e) = app_handle.clipboard().write_text(&original) {
                    log_rec!(error, "Failed to restore clipboard: {}", e);
                }
            }

            // 9. Record usage stats
            app_inner.stats.lock().await.record_session(&final_text);
            play_configured_sound(&app_handle, &app_inner, "end");
        } else {
            log_rec!(warn, "Final text is empty, skipping paste");
        }

        // 10. Close the WebSocket session
        session.close();
    }

    // 11. Hide overlay
    if let Some(overlay) = app_handle.get_webview_window("overlay") {
        let _ = overlay.hide();
    }

    // 12. Set state back to idle
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

    // Clear the active prompt ID since the session was cancelled
    if let Some(active) = app_handle.try_state::<ActivePromptId>() {
        *active.0.lock().unwrap() = None;
    }

    stop_renderer_audio(&app_handle, &app_inner, 1200).await;

    if let Some(session) = app_inner.asr_session.lock().await.take() {
        session.close();
    }
    *app_inner.asr_events.lock().await = None;
    *app_inner.latest_transcript.lock().await = (String::new(), String::new());

    let _ = app_handle.emit("overlay:event", serde_json::json!({ "type": "reset" }));
    if let Some(overlay) = app_handle.get_webview_window("overlay") {
        let _ = overlay.hide();
    }
    set_app_state(&app_handle, &app_inner, app_state::AppState::Idle).await;
}

/// Default system prompt for LLM text structuring.
const DEFAULT_STRUCTURE_PROMPT: &str = "整理语音转写内容，仅输出最终文本，不附加其他内容。\n- 删除语气词、重复内容及多余口语词汇\n- 理顺语序，保证逻辑流畅\n- 修正识别错误，还原正确词汇与专有名词\n- 忠于原意，不新增、改动信息\n- 篇幅较长则使用列表结构化呈现，短句不作格式调整";

/// Forward ASR events from the event channel to the overlay window.
/// Runs in a spawned async task for the duration of an active recording session.
async fn forward_asr_events(
    app: AppHandle,
    mut event_rx: tokio::sync::mpsc::UnboundedReceiver<crate::asr::AsrEvent>,
) {
    use crate::asr::AsrEvent;

    log_events!(debug, "Event forwarding task started");
    while let Some(event) = event_rx.recv().await {
        match event {
            AsrEvent::Transcript {
                final_text,
                partial_text,
            } => {
                // Save latest transcript in shared state
                let state = app.state::<Arc<app_state::AppInner>>();
                *state.latest_transcript.lock().await = (final_text.clone(), partial_text.clone());

                let _ = app.emit(
                    "overlay:event",
                    serde_json::json!({
                        "type": "transcript",
                        "payload": {
                            "finalText": final_text,
                            "partialText": partial_text,
                        }
                    }),
                );
            }
            AsrEvent::Error(msg) => {
                log_events!(error, "ASR error: {}", msg);
                let _ = app.emit(
                    "overlay:event",
                    serde_json::json!({
                        "type": "hint",
                        "payload": {
                            "text": msg,
                            "level": "error",
                            "variant": "text",
                        }
                    }),
                );
                // Auto-stop: reset recording state and hide overlay
                if let Some(state) = app.try_state::<RecordingState>() {
                    *state.0.lock().unwrap() = false;
                }
                if let Some(inner) = app.try_state::<Arc<app_state::AppInner>>() {
                    set_app_state(&app, &inner, app_state::AppState::Idle).await;
                }
                if let Some(overlay) = app.get_webview_window("overlay") {
                    let _ = overlay.hide();
                }
            }
            AsrEvent::Open => {
                log_events!(info, "ASR connection opened");
            }
            AsrEvent::Close { code, reason } => {
                log_events!(info, "ASR connection closed (code={:?}, reason={:?})", code, reason);
                // If connection closed during recording, auto-stop
                // Extract the flag eagerly to avoid holding MutexGuard across .await
                let was_recording = app
                    .try_state::<RecordingState>()
                    .map(|state| {
                        let mut recording = state.0.lock().unwrap();
                        let is_rec = *recording;
                        *recording = false;
                        is_rec
                    })
                    .unwrap_or(false);
                if was_recording {
                    if let Some(inner) = app.try_state::<Arc<app_state::AppInner>>() {
                        set_app_state(&app, &inner, app_state::AppState::Idle).await;
                    }
                    if let Some(overlay) = app.get_webview_window("overlay") {
                        let _ = overlay.hide();
                    }
                }
            }
        }
    }
    log_events!(debug, "Event forwarding task ended");
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
