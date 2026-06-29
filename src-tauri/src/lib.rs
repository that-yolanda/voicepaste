#[macro_use]
mod logger;
mod app_state;
mod asr;
mod commands;
mod config;
mod cue;
mod hotkey;
mod hotword;
mod llm;
mod migration;
mod model;
mod native_audio;
mod overlay;
mod paste;
mod platform;
mod recordings;
mod stats;
#[cfg(test)]
mod tests;
mod updater;
mod wav;

use app_state::*;
use asr::AsrEngine;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::{
    image::Image, tray::TrayIconBuilder, App, AppHandle, Emitter, Listener, Manager, RunEvent,
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
            overlay::setup_overlay_window(app);

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
            commands::get_overlay_layout_metrics,
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
                overlay::position_overlay(app);
                // Bring the auto-shown settings window to the front on launch.
                platform::show_settings(app);
            }
            // macOS: dock icon click while the app is already running — re-show
            // and activate settings (restoring it from minimize, or rebuilding it
            // if the user had closed the window).
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => {
                platform::show_settings(app);
            }
            RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::CloseRequested { .. },
                ..
            } if label == "settings" => {
                // Let the settings window close for real so its WebView memory is
                // released. The app stays alive via the tray + ExitRequested below;
                // platform::show_settings() rebuilds the window on the next "设置" click.
                platform::set_dock_visible(false);
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
                platform::show_settings(app);
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

/// Begin a neutral recording triggered by the hotkey matcher — the prompt is
/// decided later, on stop. If the main hotkey was used while a retryable
/// failure is shown, retry that failure instead of starting a new recording.
pub(crate) async fn on_recording_start(app_handle: AppHandle, is_main: bool) {
    if is_main {
        let app_inner = app_handle.state::<Arc<app_state::AppInner>>();
        let can_retry = matches!(*app_inner.state.lock().await, app_state::AppState::Idle)
            && app_inner.current_failure_ts.lock().await.is_some();
        if can_retry {
            let _ = retry_latest_failed_transcription(app_handle.clone()).await;
            // Retry did not start a recording — resync the matcher so it does
            // not believe one is active.
            reset_matcher_recording(&app_handle);
            return;
        }
    }

    start_recording(app_handle.clone()).await;

    // If the start aborted (config/audio failure), resync the matcher so it
    // doesn't think it's still recording.
    if !is_recording(&app_handle) {
        reset_matcher_recording(&app_handle);
    }
}

/// End the active recording and finalize with the prompt resolved from the
/// stop chord. Sets ActivePromptId just before stopping so the finishing
/// pipeline knows whether to polish.
pub(crate) async fn on_recording_stop(app_handle: AppHandle, prompt_id: Option<String>) {
    if let Some(active) = app_handle.try_state::<ActivePromptId>() {
        *active.0.lock().unwrap() = prompt_id;
    }
    stop_recording(app_handle).await;
}

/// Reset the hotkey matcher's recording tracking, e.g. after a recording is
/// cancelled or a start is diverted to retry / fails. No-op if the hotkey
/// state isn't managed yet.
fn reset_matcher_recording(app_handle: &AppHandle) {
    if let Some(hc) = app_handle.try_state::<hotkey::HotkeyConfig>() {
        hotkey::reset_recording(&hc);
    }
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
    if let Err(e) = native_audio::start_capture(app_handle.clone(), Arc::clone(&app_inner)).await {
        *recording_state.0.lock().unwrap() = false;
        set_app_state(&app_handle, &app_inner, app_state::AppState::Idle).await;
        if let Some(overlay) = app_handle.get_window("overlay") {
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

    // Check if recording was cancelled during warmup (hold mode: quick press-release)
    if !*recording_state.0.lock().unwrap() {
        log_rec!(warn, "Cancelled during warmup, aborting start");
        native_audio::stop_audio_capture(&app_handle, &app_inner, 1200).await;
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
        recordings::current_recording_wav_string(app_inner).await,
        Some(ts.to_string()),
    );
    *app_inner.current_failure_ts.lock().await = Some(failure_ts);
    overlay::emit_retryable_error_hint(app_handle, app_inner, message).await;
    overlay::set_overlay_retry_interaction(app_handle, true);
    set_app_state(app_handle, app_inner, app_state::AppState::Idle).await;
    overlay::schedule_retry_overlay_hide(app_handle.clone(), Arc::clone(app_inner));
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
    let samples = wav::read_wav_16k_mono(&path)?;
    if samples.is_empty() {
        return Err("录音文件为空，无法重试".to_string());
    }

    overlay::set_overlay_retry_interaction(&app_handle, false);
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
    if let Some(overlay) = app_handle.get_window("overlay") {
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
            reset_matcher_recording(&app_handle);
            app_inner.pending_audio.lock().await.clear();
            native_audio::stop_audio_capture(&app_handle, &app_inner, 1200).await;
            recordings::save_recording_wav(&app_handle, &app_inner).await;
            let message = format!("ASR 连接失败: {}，请检查网络连接", e);
            recordings::record_transcription_failure(&app_handle, &app_inner, &message).await;
            // Emit error hint BEFORE setting idle so the overlay shows it: the
            // frontend's idle handler only clears "info"-level hints.
            overlay::emit_retryable_error_hint(&app_handle, &app_inner, &message).await;
            set_app_state(&app_handle, &app_inner, app_state::AppState::Idle).await;
            // Auto-hide after a delay so the user can read it; guard: still idle.
            overlay::schedule_retry_overlay_hide(app_handle.clone(), Arc::clone(&app_inner));
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
    native_audio::stop_audio_capture(&app_handle, &app_inner, 1200).await;
    // Snapshot whether real sound was captured before save_recording_wav drains
    // the buffer: a silent stop ends immediately, but speech whose transcript was
    // lost (slow/failed network) must keep the retry path even with no result yet.
    let captured_audio_signal = {
        let audio = app_inner.recording_audio.lock().await;
        wav::recording_has_audio_signal(&audio)
    };
    recordings::save_recording_wav(&app_handle, &app_inner).await;

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
                    recordings::discard_recording_artifacts(&app_inner).await;
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
            recordings::discard_recording_artifacts(&app_inner).await;
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
                recordings::record_transcription_failure(&app_handle, &app_inner, &e).await;
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
            recordings::record_transcription_failure(&app_handle, &app_inner, message).await;
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
    overlay::set_overlay_retry_interaction(app_handle, false);
    let _ = app_handle.emit("overlay:event", serde_json::json!({ "type": "reset" }));
    if let Some(overlay) = app_handle.get_window("overlay") {
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

    native_audio::stop_audio_capture(&app_handle, &app_inner, 1200).await;

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
            cue::emit_cue(app, app_inner, "start");
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

    native_audio::stop_audio_capture(app, app_inner, 1200).await;
    recordings::save_recording_wav(app, app_inner).await;

    if combined.trim().is_empty() {
        recordings::record_transcription_failure(app, app_inner, message).await;
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
async fn finalize_and_paste(
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
                let _ = app_handle.emit(
                    "overlay:event",
                    serde_json::json!({
                        "type": "hint",
                        "payload": { "text": e, "level": "warn", "variant": "text" }
                    }),
                );
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
            // Show a "润色中…" hint (with shimmer) in place of the recognized text
            // while the LLM is working, until polishing completes or fails.
            let _ = app_handle.emit(
                "overlay:event",
                serde_json::json!({
                    "type": "hint",
                    "payload": { "text": "润色中…", "level": "info", "variant": "progress" }
                }),
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
    recordings::record_success_and_apply_retention(
        app_handle,
        app_inner,
        &final_text,
        keep_recordings,
    )
    .await;
    cue::emit_cue(app_handle, app_inner, "end");
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
