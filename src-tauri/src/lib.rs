mod app_state;
mod asr;
mod commands;
mod config;
mod hotkey;
mod llm;
mod logger;
mod paste;
mod stats;

use app_state::*;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    App, AppHandle, Emitter, Manager, RunEvent,
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

            // Initialize services
            let config_manager = config::ConfigManager::new(&data_dir, &resource_dir);
            let log_path = data_dir.join("voicepaste.log");
            let logger_instance = logger::Logger::new(log_path);
            let stats_service = stats::StatsService::new(&data_dir);

            // Read hotkey mode before config_manager is moved into app state
            let hotkey_mode = config_manager
                .load_config()
                .map(|c| c.app.hotkey_mode.clone())
                .unwrap_or_else(|_| "toggle".to_string());

            let app_state = create_app_state(config_manager, logger_instance, stats_service);
            app.manage(app_state);

            // Recording state toggle (used by global shortcut handler)
            app.manage(RecordingState(std::sync::Mutex::new(false)));

            // Hotkey mode: "toggle" or "hold"
            app.manage(HotkeyMode(std::sync::Mutex::new(hotkey_mode)));

            // Active prompt ID for the current recording session (None = main hotkey)
            app.manage(ActivePromptId(std::sync::Mutex::new(None)));

            eprintln!("[voicepaste] setup: starting...");
            eprintln!("[voicepaste] data_dir: {:?}", data_dir);
            eprintln!("[voicepaste] resource_dir: {:?}", resource_dir);

            // Setup overlay window properties
            setup_overlay_window(app);

            // Setup system tray
            setup_tray(app)?;

            // Setup global hotkeys via keytap
            eprintln!("[voicepaste] setting up global hotkeys (keytap)...");
            setup_keytap_hotkeys(app)?;
            eprintln!("[voicepaste] global hotkeys ready");

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_app_config,
            commands::get_settings_data,
            commands::save_config,
            commands::save_config_object,
            commands::reset_config,
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
            commands::select_sound_file,
            commands::play_sound_file,
            commands::get_log_path,
            commands::get_config_path,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            RunEvent::Ready => {
                // Position the overlay after the event loop is fully initialized,
                // avoiding "Window move completed without beginning" on macOS.
                position_overlay(app);
            }
            RunEvent::ExitRequested { api, .. } => {
                // Keep the app running in the tray when all windows are closed
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
/// Called from RunEvent::Ready to avoid macOS window server timing warnings.
fn position_overlay(app_handle: &AppHandle) {
    if let Some(overlay) = app_handle.get_webview_window("overlay") {
        // Set window properties here (RunEvent::Ready) rather than during setup()
        // to avoid macOS window server timing issues.
        let _ = overlay.set_ignore_cursor_events(true);
        let _ = overlay.set_visible_on_all_workspaces(true);

        if let Ok(monitors) = overlay.available_monitors() {
            if let Some(primary) = monitors.into_iter().next() {
                let screen_size = primary.size();
                let screen_pos = primary.position();
                let work_area_height = screen_size.height as i32;

                let overlay_width = 720i32;
                let overlay_height = 300i32;
                let x = screen_pos.x + (screen_size.width as i32 - overlay_width) / 2;
                let y = work_area_height - overlay_height - 48;

                let _ = overlay.set_position(tauri::Position::Physical(
                    tauri::PhysicalPosition::new(x, y),
                ));
                let _ = overlay.set_size(tauri::Size::Physical(tauri::PhysicalSize::new(
                    overlay_width as u32,
                    overlay_height as u32,
                )));
            }
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
    eprintln!("[recording] state: {}", app_state_name(&next_state));
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
        .join("renderer")
        .join("assets")
        .join(filename)
}

fn play_configured_sound(app: &AppHandle, app_inner: &Arc<app_state::AppInner>, name: &str) {
    let config = match app_inner.config_manager.load_config() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("[sound] config load failed: {}", error);
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

/// Setup the system tray icon with menu items.
fn setup_tray(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    let settings_item = MenuItemBuilder::with_id("settings", "打开配置").build(app)?;
    let quit_item = MenuItemBuilder::with_id("quit", "退出").build(app)?;

    let menu = MenuBuilder::new(app)
        .item(&settings_item)
        .separator()
        .item(&quit_item)
        .build()?;

    let _tray = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("VoicePaste")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "settings" => {
                if let Some(window) = app.get_webview_window("settings") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Click on tray icon opens settings
            if let tauri::tray::TrayIconEvent::Click { .. } = event {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("settings") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)?;

    Ok(())
}

/// Initialize keytap-based global hotkey listener.
fn setup_keytap_hotkeys(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    let app_inner: std::sync::Arc<app_state::AppInner> =
        (*app.state::<std::sync::Arc<app_state::AppInner>>()).clone();

    let config = app_inner.config_manager.load_config().map_err(|e| format!("{}", e))?;
    let hotkey_str = match &config.app.hotkey {
        serde_yaml::Value::String(s) => s.clone(),
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
    app.manage(HotkeyManagerState(std::sync::Mutex::new(hotkey_manager)));

    Ok(())
}

/// Wrapper to keep the HotkeyManager alive as Tauri managed state.
#[allow(dead_code)]
struct HotkeyManagerState(std::sync::Mutex<hotkey::HotkeyManager>);

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
            eprintln!("[recording] failed to load config: {}", e);
            let _ = app_handle.emit("overlay:event", serde_json::json!({
                "type": "hint",
                "payload": { "text": format!("配置加载失败: {}", e), "level": "error", "variant": "text" }
            }));
            return;
        }
    };

    *app_inner.latest_transcript.lock().await = (String::new(), String::new());
    let _ = app_handle.emit("overlay:event", serde_json::json!({ "type": "reset" }));
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
        eprintln!("[recording] audio warmup failed: {}", e);
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
        eprintln!("[recording] cancelled during warmup, aborting start");
        stop_renderer_audio(&app_handle, &app_inner, 1200).await;
        set_app_state(&app_handle, &app_inner, app_state::AppState::Idle).await;
        if let Some(overlay) = app_handle.get_webview_window("overlay") {
            let _ = overlay.hide();
        }
        return;
    }

    // 3. Create ASR session
    match crate::asr::create_asr_session(&config.connection, &config.audio, &config.request)
        .await
    {
        Ok((session, event_rx)) => {
            // Check if recording was cancelled during ASR connection
            if !*recording_state.0.lock().unwrap() {
                eprintln!("[recording] cancelled during ASR connection, closing session");
                session.close();
                stop_renderer_audio(&app_handle, &app_inner, 1200).await;
                set_app_state(&app_handle, &app_inner, app_state::AppState::Idle).await;
                if let Some(overlay) = app_handle.get_webview_window("overlay") {
                    let _ = overlay.hide();
                }
                return;
            }

            *app_inner.asr_session.lock().await = Some(session.clone());
            set_app_state(&app_handle, &app_inner, app_state::AppState::Recording).await;

            let _ = app_handle.emit(
                "overlay:event",
                serde_json::json!({
                    "type": "recording:start",
                }),
            );

            let app_for_events = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                forward_asr_events(app_for_events, event_rx).await;
            });
        }
        Err(e) => {
            eprintln!("[recording] ASR connection failed: {}", e);
            *recording_state.0.lock().unwrap() = false;
            stop_renderer_audio(&app_handle, &app_inner, 1200).await;
            set_app_state(&app_handle, &app_inner, app_state::AppState::Idle).await;
            let _ = app_handle.emit("overlay:event", serde_json::json!({
                "type": "hint",
                "payload": { "text": format!("ASR 连接失败: {}", e), "level": "error", "variant": "text" }
            }));
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

        let trimmed = text.trim().to_string();
        if !trimmed.is_empty() {
            let preview = trimmed.chars().take(60).collect::<String>();
            eprintln!(
                "[recording] final text ({} chars): {:?}",
                trimmed.chars().count(),
                preview
            );

            // 5. Load config for LLM / behavior settings
            let config = app_inner.config_manager.load_config().ok();

            let mut trimmed = trimmed;
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
                if config.llm.enabled && active_prompt_id.is_some() {
                    let prompts = app_inner.config_manager.load_prompts();
                    let system_prompt = active_prompt_id
                        .as_ref()
                        .and_then(|pid| {
                            prompts
                                .iter()
                                .find(|p| &p.id == pid)
                                .map(|p| p.prompt.clone())
                                .filter(|p| !p.trim().is_empty())
                        })
                        .unwrap_or_else(|| DEFAULT_STRUCTURE_PROMPT.to_string());
                    eprintln!(
                        "[recording] applying LLM structure_text (prompt_id: {:?})...",
                        active_prompt_id
                    );
                    match crate::llm::call_llm_api(&config.llm, &trimmed, &system_prompt).await {
                        Ok(result) => {
                            eprintln!("[recording] LLM polishing succeeded ({} chars)", result.chars().count());
                            result
                        }
                        Err(e) => {
                            eprintln!("[recording] LLM polishing failed: {}, using raw text", e);
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
            if let Err(e) = app_handle.clipboard().write_text(&final_text) {
                eprintln!("[recording] clipboard write failed: {}", e);
                let _ = app_handle.emit("overlay:event", serde_json::json!({
                    "type": "hint",
                    "payload": { "text": format!("剪贴板写入失败: {}", e), "level": "error", "variant": "text" }
                }));
            }

            // 8. Simulate paste keystroke
            let _result = crate::paste::simulate_paste();

            // 9. Record usage stats
            app_inner.stats.lock().await.record_session(&final_text);
            play_configured_sound(&app_handle, &app_inner, "end");
        } else {
            eprintln!("[recording] final text is empty, skipping paste");
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
    eprintln!("[recording] cancel requested");

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

    eprintln!("[events] event forwarding task started");
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
                eprintln!("[events] ASR error: {}", msg);
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
                eprintln!("[events] ASR connection opened");
            }
            AsrEvent::Close { code, reason } => {
                eprintln!(
                    "[events] ASR connection closed (code={}, reason={:?})",
                    code, reason
                );
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
    eprintln!("[events] event forwarding task ended");
}

/// Reload all hotkey bindings from the current config and prompts.
/// Called after saving config or prompts so changes take effect immediately.
pub fn reload_hotkey_bindings(app: &AppHandle) {
    let Some(hc) = app.try_state::<hotkey::HotkeyConfig>() else {
        eprintln!("[hotkey] HotkeyConfig not in managed state");
        return;
    };

    let app_inner = app.state::<std::sync::Arc<app_state::AppInner>>();
    let config = match app_inner.config_manager.load_config() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[hotkey] failed to load config for reload: {}", e);
            return;
        }
    };

    let hotkey_str = match &config.app.hotkey {
        serde_yaml::Value::String(s) => s.clone(),
        _ => String::new(),
    };

    let mode = app
        .try_state::<HotkeyMode>()
        .map(|m| m.0.lock().unwrap().clone())
        .unwrap_or_else(|| "toggle".to_string());

    let prompts = app_inner.config_manager.load_prompts();
    hotkey::reload_bindings(&hc, &hotkey_str, &mode, &prompts);
}

