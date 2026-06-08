mod app_state;
mod asr;
mod commands;
mod config;
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
use tauri_plugin_global_shortcut::{Code, Shortcut};

fn escape_shortcut() -> Shortcut {
    Shortcut::new(None, Code::Escape)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
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

            // Setup global shortcuts from config
            eprintln!("[voicepaste] setting up global shortcuts...");
            setup_global_shortcuts(app)?;
            eprintln!("[voicepaste] global shortcuts ready");

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
        app_state::AppState::Error => "error",
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
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

    let _ = app.global_shortcut().unregister(escape_shortcut());
    if !should_enable_escape_shortcut(state) {
        return;
    }

    let app_handle = app.clone();
    let result = app.global_shortcut().on_shortcut(
        escape_shortcut(),
        move |_triggered_app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                let handle = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    cancel_recording(handle).await;
                });
            }
        },
    );

    if let Err(error) = result {
        eprintln!("[shortcut] failed to register Escape: {}", error);
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

/// Register global shortcuts based on the current configuration.
/// Reads the hotkey from config.yaml and registers it via the global-shortcut plugin.
fn setup_global_shortcuts(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

    // Load config to get the hotkey
    let data_dir = app
        .path()
        .app_data_dir()
        .expect("Failed to resolve app data dir");
    let resource_dir = app
        .path()
        .resource_dir()
        .expect("Failed to resolve resource dir");
    let config_manager = config::ConfigManager::new(&data_dir, &resource_dir);

    if let Ok(config) = config_manager.load_config() {
        let hotkey_value = &config.app.hotkey;
        let hotkey_mode = config.app.hotkey_mode.as_str();
        eprintln!("[shortcut] config loaded, hotkey value: {:?}, mode: {}", hotkey_value, hotkey_mode);

        // For simple string hotkeys (like "Control+Space", "F13"), register via plugin
        if let serde_yaml::Value::String(hotkey_str) = hotkey_value {
            eprintln!("[shortcut] hotkey string: '{}'", hotkey_str);
            if !hotkey_str.is_empty() {
                // Parse the accelerator string and register
                if let Some(shortcut) = parse_accelerator_to_shortcut(hotkey_str) {
                    eprintln!("[shortcut] registering shortcut for: {} (mode: {})", hotkey_str, hotkey_mode);
                    let app_handle = app.handle().clone();
                    let mode = hotkey_mode.to_string();
                    app.global_shortcut().on_shortcut(
                        shortcut,
                        move |_triggered_app, _triggered_shortcut, event| {
                            let handle = app_handle.clone();
                            let mode = mode.clone();
                            #[allow(unreachable_patterns)]
                            match event.state {
                                ShortcutState::Pressed => {
                                    tauri::async_runtime::spawn(async move {
                                        on_hotkey_pressed(handle, &mode, None).await;
                                    });
                                }
                                ShortcutState::Released => {
                                    tauri::async_runtime::spawn(async move {
                                        on_hotkey_released(handle, &mode).await;
                                    });
                                }
                                _ => {}
                            }
                        },
                    )?;
                } else {
                    eprintln!("[shortcut] failed to parse hotkey: '{}'", hotkey_str);
                }
            }
        }
        // For array hotkeys (custom key combinations), the rdev listener handles them
    } else {
        eprintln!("[shortcut] failed to load config");
    }

    // Register prompt shortcuts
    let prompts = config_manager.load_prompts();
    for prompt in &prompts {
        let hotkey = &prompt.hotkey;
        let shortcut = parse_prompt_hotkey(hotkey);

        if let Some(shortcut) = shortcut {
            let app_handle = app.handle().clone();
            let prompt_id = prompt.id.clone();
            let prompt_title = prompt.title.clone();
            let prompt_mode = prompt.hotkey_mode.clone();
            app.global_shortcut()
                .on_shortcut(shortcut, move |_triggered_app, _triggered, event| {
                    let handle = app_handle.clone();
                    let mode = prompt_mode.clone();
                    let pid = prompt_id.clone();
                    #[allow(unreachable_patterns)]
                    match event.state {
                        ShortcutState::Pressed => {
                            eprintln!(
                                "[shortcut] prompt shortcut triggered: {} ({})",
                                prompt_title, prompt_id
                            );
                            tauri::async_runtime::spawn(async move {
                                on_hotkey_pressed(handle, &mode, Some(pid)).await;
                            });
                        }
                        ShortcutState::Released => {
                            tauri::async_runtime::spawn(async move {
                                on_hotkey_released(handle, &mode).await;
                            });
                        }
                        _ => {}
                    }
                })
                .ok();
        } else if !hotkey.is_sequence() || !hotkey.as_sequence().unwrap().is_empty() {
            eprintln!(
                "[shortcut] prompt '{}' hotkey {:?} uses unsupported keycodes, skipping",
                prompt.title, hotkey
            );
        }
    }

    Ok(())
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

    // 3. Create ASR session
    match crate::asr::create_asr_session(&config.connection, &config.audio, &config.request)
        .await
    {
        Ok((session, event_rx)) => {
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

/// Unregister all global shortcuts and re-register a single hotkey.
/// Used after saving config so the new hotkey takes effect immediately
/// without requiring an app restart.
pub fn reload_shortcuts(
    app: &AppHandle,
    hotkey_str: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

    // Unregister all current shortcuts
    let _ = app.global_shortcut().unregister_all();

    // Read the current hotkey mode from managed state
    let mode = app
        .try_state::<HotkeyMode>()
        .map(|m| m.0.lock().unwrap().clone())
        .unwrap_or_else(|| "toggle".to_string());

    // Register the new hotkey
    if !hotkey_str.is_empty() {
        if let Some(shortcut) = parse_accelerator_to_shortcut(hotkey_str) {
            let app_handle = app.clone();
            let mode_clone = mode.clone();
            app.global_shortcut().on_shortcut(
                shortcut,
                move |_triggered_app, _triggered, event| {
                    let handle = app_handle.clone();
                    let m = mode_clone.clone();
                    #[allow(unreachable_patterns)]
                    match event.state {
                        ShortcutState::Pressed => {
                            tauri::async_runtime::spawn(async move {
                                on_hotkey_pressed(handle, &m, None).await;
                            });
                        }
                        ShortcutState::Released => {
                            tauri::async_runtime::spawn(async move {
                                on_hotkey_released(handle, &m).await;
                            });
                        }
                        _ => {}
                    }
                },
            )?;
        } else {
            eprintln!("[shortcut] reload: failed to parse hotkey '{}'", hotkey_str);
        }
    }

    // Re-register prompt shortcuts (unregister_all above removed them)
    let data_dir = app.path().app_data_dir().ok();
    let resource_dir = app.path().resource_dir().ok();
    if let (Some(dd), Some(rd)) = (data_dir, resource_dir) {
        let cm = config::ConfigManager::new(&dd, &rd);
        let prompts = cm.load_prompts();
        for prompt in &prompts {
            let shortcut = parse_prompt_hotkey(&prompt.hotkey);
            if let Some(shortcut) = shortcut {
                let app_handle = app.clone();
                let prompt_id = prompt.id.clone();
                let prompt_mode = prompt.hotkey_mode.clone();
                app.global_shortcut()
                    .on_shortcut(shortcut, move |_app, _shortcut, event| {
                        let handle = app_handle.clone();
                        let mode = prompt_mode.clone();
                        let pid = prompt_id.clone();
                        #[allow(unreachable_patterns)]
                        match event.state {
                            ShortcutState::Pressed => {
                                tauri::async_runtime::spawn(async move {
                                    on_hotkey_pressed(handle, &mode, Some(pid)).await;
                                });
                            }
                            ShortcutState::Released => {
                                tauri::async_runtime::spawn(async move {
                                    on_hotkey_released(handle, &mode).await;
                                });
                            }
                            _ => {}
                        }
                    })
                    .ok();
            }
        }
    }

    Ok(())
}

/// Parse a prompt hotkey value that can be either:
/// - A string array like `["Control+Shift+A"]` (new format, from DOM recording)
/// - A number array like `[29, 54, 4]` (legacy uIOhook format)
fn parse_prompt_hotkey(hotkey: &serde_yaml::Value) -> Option<Shortcut> {
    let seq = hotkey.as_sequence()?;

    // Try string format first: ["Control+Shift+A"]
    if let Some(first) = seq.first() {
        if let Some(s) = first.as_str() {
            return parse_accelerator_to_shortcut(s);
        }
    }

    // Fall back to uIOhook keycode format: [29, 54, 4]
    let keycodes: Vec<u32> = seq.iter().filter_map(|v| v.as_u64().map(|n| n as u32)).collect();
    if keycodes.is_empty() {
        return None;
    }
    keycode_array_to_shortcut(&keycodes)
}

/// Convert a uIOhook keycode array (used in prompt hotkeys) to a Tauri
/// global-shortcut `Shortcut`. Only modifiers and common special keys are
/// mapped; alphanumeric keys are not supported yet.
fn keycode_array_to_shortcut(keycodes: &[u32]) -> Option<Shortcut> {
    use tauri_plugin_global_shortcut::{Code, Modifiers};

    let mut modifiers = Modifiers::empty();
    let mut main_key = None;

    for &kc in keycodes {
        match kc {
            0x001D | 0x009D => modifiers |= Modifiers::CONTROL, // Left/Right Ctrl
            0x002E | 0x0036 => modifiers |= Modifiers::SHIFT,   // Left/Right Shift
            0x0038 | 0x0138 => modifiers |= Modifiers::ALT,     // Left/Right Alt
            0x0037 | 0x00D7 => modifiers |= Modifiers::SUPER,   // Left/Right Meta/Cmd
            0x0020 => main_key = Some(Code::Space),
            0x0028 => main_key = Some(Code::Enter),
            0x002A => main_key = Some(Code::Backspace),
            0x002B => main_key = Some(Code::Tab),
            0x003B => main_key = Some(Code::F1),
            0x003C => main_key = Some(Code::F2),
            0x003D => main_key = Some(Code::F3),
            0x003E => main_key = Some(Code::F4),
            0x003F => main_key = Some(Code::F5),
            0x0040 => main_key = Some(Code::F6),
            0x0041 => main_key = Some(Code::F7),
            0x0042 => main_key = Some(Code::F8),
            0x0043 => main_key = Some(Code::F9),
            0x0044 => main_key = Some(Code::F10),
            0x0057 => main_key = Some(Code::F11),
            0x0058 => main_key = Some(Code::F12),
            _ => {
                eprintln!(
                    "[shortcut] unsupported keycode 0x{:04X}, skipping prompt shortcut",
                    kc
                );
                return None;
            }
        }
    }

    main_key.map(|k| {
        let mods = if modifiers.is_empty() {
            None
        } else {
            Some(modifiers)
        };
        Shortcut::new(mods, k)
    })
}

/// Parse an Electron-style accelerator string (e.g. "Control+Space", "F13")
/// into a Tauri global-shortcut Shortcut.
fn parse_accelerator_to_shortcut(accelerator: &str) -> Option<Shortcut> {
    use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};

    let parts: Vec<&str> = accelerator.split('+').map(|p| p.trim()).collect();
    if parts.is_empty() {
        return None;
    }

    let mut modifiers = Modifiers::empty();
    let mut code = None;

    for part in parts {
        let lower = part.to_lowercase();
        match lower.as_str() {
            "ctrl" | "control" => modifiers |= Modifiers::CONTROL,
            "shift" => modifiers |= Modifiers::SHIFT,
            "alt" | "option" => modifiers |= Modifiers::ALT,
            "super" | "cmd" | "command" | "meta" => modifiers |= Modifiers::SUPER,
            "cmdorctrl" | "commandorcontrol" => {
                if cfg!(target_os = "macos") {
                    modifiers |= Modifiers::SUPER;
                } else {
                    modifiers |= Modifiers::CONTROL;
                }
            }
            "space" => code = Some(Code::Space),
            "enter" | "return" => code = Some(Code::Enter),
            "tab" => code = Some(Code::Tab),
            "escape" | "esc" => code = Some(Code::Escape),
            "backspace" => code = Some(Code::Backspace),
            "up" => code = Some(Code::ArrowUp),
            "down" => code = Some(Code::ArrowDown),
            "left" => code = Some(Code::ArrowLeft),
            "right" => code = Some(Code::ArrowRight),
            s if s.starts_with('f') && s.len() <= 3 => {
                if let Ok(n) = s[1..].parse::<u32>() {
                    code = match n {
                        1 => Some(Code::F1),
                        2 => Some(Code::F2),
                        3 => Some(Code::F3),
                        4 => Some(Code::F4),
                        5 => Some(Code::F5),
                        6 => Some(Code::F6),
                        7 => Some(Code::F7),
                        8 => Some(Code::F8),
                        9 => Some(Code::F9),
                        10 => Some(Code::F10),
                        11 => Some(Code::F11),
                        12 => Some(Code::F12),
                        13 => Some(Code::F13),
                        14 => Some(Code::F14),
                        15 => Some(Code::F15),
                        16 => Some(Code::F16),
                        17 => Some(Code::F17),
                        18 => Some(Code::F18),
                        19 => Some(Code::F19),
                        20 => Some(Code::F20),
                        21 => Some(Code::F21),
                        22 => Some(Code::F22),
                        23 => Some(Code::F23),
                        24 => Some(Code::F24),
                        _ => None,
                    };
                }
            }
            s if s.len() == 1 && s.chars().next().unwrap().is_ascii_alphabetic() => {
                code = match s {
                    "a" => Some(Code::KeyA),
                    "b" => Some(Code::KeyB),
                    "c" => Some(Code::KeyC),
                    "d" => Some(Code::KeyD),
                    "e" => Some(Code::KeyE),
                    "f" => Some(Code::KeyF),
                    "g" => Some(Code::KeyG),
                    "h" => Some(Code::KeyH),
                    "i" => Some(Code::KeyI),
                    "j" => Some(Code::KeyJ),
                    "k" => Some(Code::KeyK),
                    "l" => Some(Code::KeyL),
                    "m" => Some(Code::KeyM),
                    "n" => Some(Code::KeyN),
                    "o" => Some(Code::KeyO),
                    "p" => Some(Code::KeyP),
                    "q" => Some(Code::KeyQ),
                    "r" => Some(Code::KeyR),
                    "s" => Some(Code::KeyS),
                    "t" => Some(Code::KeyT),
                    "u" => Some(Code::KeyU),
                    "v" => Some(Code::KeyV),
                    "w" => Some(Code::KeyW),
                    "x" => Some(Code::KeyX),
                    "y" => Some(Code::KeyY),
                    "z" => Some(Code::KeyZ),
                    _ => None,
                };
            }
            s if s.len() == 1 && s.chars().next().unwrap().is_ascii_digit() => {
                code = match s {
                    "0" => Some(Code::Digit0),
                    "1" => Some(Code::Digit1),
                    "2" => Some(Code::Digit2),
                    "3" => Some(Code::Digit3),
                    "4" => Some(Code::Digit4),
                    "5" => Some(Code::Digit5),
                    "6" => Some(Code::Digit6),
                    "7" => Some(Code::Digit7),
                    "8" => Some(Code::Digit8),
                    "9" => Some(Code::Digit9),
                    _ => None,
                };
            }
            _ => {}
        }
    }

    code.map(|c| {
        let mods = if modifiers.is_empty() {
            None
        } else {
            Some(modifiers)
        };
        Shortcut::new(mods, c)
    })
}
