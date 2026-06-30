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
mod overlay;
mod paste;
mod platform;
mod recording;
mod sound;
mod stats;
#[cfg(test)]
mod tests;
mod updater;

use app_state::*;
use tauri::{image::Image, tray::TrayIconBuilder, App, Listener, Manager, RunEvent};

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
            hotkey::setup_keytap_hotkeys(app.handle())?;
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
