use crate::app_state::AppHandle as AppState;
use crate::config::PromptItem;
use crate::paste;
use crate::HotkeyMode;
use tauri::{AppHandle, Emitter, Manager, State};

// Re-export paste::PasteResult for use in commands
use paste::PasteResult;

/// Detect the actual OS-level light/dark theme preference.
fn detect_system_theme() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        // AppleInterfaceStyle key is "Dark" in dark mode, absent in light mode.
        if let Ok(output) = std::process::Command::new("defaults")
            .args(["read", "-g", "AppleInterfaceStyle"])
            .output()
        {
            if String::from_utf8_lossy(&output.stdout).trim() == "Dark" {
                return "dark";
            }
        }
        "light"
    }
    #[cfg(target_os = "windows")]
    {
        // Check registry: AppsUseLightTheme DWORD — 0 = dark, 1 = light.
        if let Ok(output) = std::process::Command::new("reg")
            .args([
                "query",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
                "/v",
                "AppsUseLightTheme",
            ])
            .output()
        {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if stdout.contains("0x0") {
                return "dark";
            }
            if stdout.contains("0x1") {
                return "light";
            }
        }
        "dark"
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        "dark"
    }
}

/// Resolve a theme preference ("system" / "light" / "dark") to an actual theme value.
fn resolve_theme(preference: &str) -> String {
    match preference {
        "system" => detect_system_theme().to_string(),
        other => other.to_string(),
    }
}

/// Get app configuration for the overlay.
#[tauri::command]
pub async fn get_app_config(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let config = state.config_manager.load_config()?;
    let hotkey = match &config.app.hotkey {
        serde_yaml::Value::String(s) => s.clone(),
        serde_yaml::Value::Sequence(arr) => {
            let keys: Vec<String> = arr
                .iter()
                .filter_map(|v| v.as_u64().map(|n| n.to_string()))
                .collect();
            keys.join("+")
        }
        _ => String::new(),
    };
    Ok(serde_json::json!({
        "hotkey": hotkey,
        "platform": std::env::consts::OS,
        "overlayStyle": config.app.overlay_style,
        "theme": config.app.theme,
        "sound": {
            "enabled": config.app.sound.as_ref().map(|s| s.enabled).unwrap_or(true),
            "start_sound": config.app.sound.as_ref().map(|s| s.start_sound.clone()).unwrap_or_default(),
            "end_sound": config.app.sound.as_ref().map(|s| s.end_sound.clone()).unwrap_or_default(),
        },
    }))
}

/// Get settings data for the settings window.
#[tauri::command]
pub async fn get_settings_data(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let config = state.config_manager.load_config()?;
    let config_text = state.config_manager.read_config_text()?;
    let parsed_config = state.config_manager.get_editable_config()?;

    let hotkey = match &config.app.hotkey {
        serde_yaml::Value::String(s) => s.clone(),
        serde_yaml::Value::Sequence(arr) => {
            let keys: Vec<String> = arr
                .iter()
                .filter_map(|v| v.as_u64().map(|n| n.to_string()))
                .collect();
            keys.join("+")
        }
        _ => String::new(),
    };

    let version = env!("CARGO_PKG_VERSION").to_string();

    Ok(serde_json::json!({
        "configPath": state.config_manager.config_path().to_string_lossy(),
        "configText": config_text,
        "parsedConfig": parsed_config,
        "runtime": {
            "hotkey": hotkey,
            "hotkeyDisplay": hotkey,
            "microphoneStatus": check_microphone(),
            "accessibilityStatus": check_accessibility(),
            "version": version,
            "platform": std::env::consts::OS,
            "theme": {
                "preference": config.app.theme.clone(),
                "resolved": resolve_theme(&config.app.theme),
            },
        },
    }))
}

/// Save config as raw YAML text.
#[tauri::command]
pub async fn save_config(
    app: AppHandle,
    state: State<'_, AppState>,
    config_text: String,
) -> Result<serde_json::Value, String> {
    state.config_manager.save_config_text(&config_text)?;

    // Re-register shortcuts with the new hotkey from the saved config
    let updated_config = state.config_manager.load_config()?;

    // Sync hotkey mode
    if let Some(hotkey_mode) = app.try_state::<HotkeyMode>() {
        *hotkey_mode.0.lock().unwrap() = updated_config.app.hotkey_mode.clone();
    }

    crate::reload_hotkey_bindings(&app);

    // Notify the overlay so it can re-apply the glass appearance live.
    let _ = app.emit(
        "overlay:event",
        serde_json::json!({
            "type": "appearance",
            "payload": {
                "platform": std::env::consts::OS,
                "overlayStyle": updated_config.app.overlay_style,
                "theme": updated_config.app.theme,
            }
        }),
    );

    // Notify the settings window when the theme changes.
    let _ = app.emit(
        "settings:event",
        serde_json::json!({
            "type": "theme-changed",
            "payload": {
                "preference": updated_config.app.theme,
                "resolved": resolve_theme(&updated_config.app.theme),
            }
        }),
    );

    let updated_text = state.config_manager.read_config_text()?;
    let config = state.config_manager.load_config()?;
    let hotkey = match &config.app.hotkey {
        serde_yaml::Value::String(s) => s.clone(),
        _ => String::new(),
    };

    Ok(serde_json::json!({
        "ok": true,
        "configText": updated_text,
        "runtime": {
            "hotkey": hotkey,
            "hotkeyDisplay": hotkey,
        },
    }))
}

/// Save config as a parsed object.
#[tauri::command]
pub async fn save_config_object(
    app: AppHandle,
    state: State<'_, AppState>,
    config_object: serde_yaml::Value,
) -> Result<serde_json::Value, String> {
    state.config_manager.save_config(&config_object)?;

    // Sync hotkey mode from saved config
    let updated_config = state.config_manager.load_config()?;
    if let Some(hotkey_mode) = app.try_state::<HotkeyMode>() {
        *hotkey_mode.0.lock().unwrap() = updated_config.app.hotkey_mode.clone();
    }

    // Re-register shortcuts with the new hotkey from the config object
    crate::reload_hotkey_bindings(&app);

    // Notify the overlay so it can re-apply the glass appearance live.
    let _ = app.emit(
        "overlay:event",
        serde_json::json!({
            "type": "appearance",
            "payload": {
                "platform": std::env::consts::OS,
                "overlayStyle": updated_config.app.overlay_style,
                "theme": updated_config.app.theme,
            }
        }),
    );

    // Notify the settings window when the theme changes.
    let _ = app.emit(
        "settings:event",
        serde_json::json!({
            "type": "theme-changed",
            "payload": {
                "preference": updated_config.app.theme,
                "resolved": resolve_theme(&updated_config.app.theme),
            }
        }),
    );

    let config_text = state.config_manager.read_config_text()?;
    let parsed = state.config_manager.get_editable_config()?;
    let config = state.config_manager.load_config()?;
    let hotkey = match &config.app.hotkey {
        serde_yaml::Value::String(s) => s.clone(),
        _ => String::new(),
    };

    Ok(serde_json::json!({
        "ok": true,
        "configText": config_text,
        "parsedConfig": parsed,
        "runtime": {
            "hotkey": hotkey,
            "hotkeyDisplay": hotkey,
        },
    }))
}

/// Reset config to default and reload shortcuts.
#[tauri::command]
pub async fn reset_config(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    state.config_manager.reset_to_default()?;

    // Reload shortcuts with the default hotkey
    let config = state.config_manager.load_config()?;
    if let Some(hotkey_mode) = app.try_state::<HotkeyMode>() {
        *hotkey_mode.0.lock().unwrap() = config.app.hotkey_mode.clone();
    }
    crate::reload_hotkey_bindings(&app);

    let config_text = state.config_manager.read_config_text()?;
    let parsed = state.config_manager.get_editable_config()?;

    Ok(serde_json::json!({
        "ok": true,
        "configText": config_text,
        "parsedConfig": parsed,
    }))
}

/// Load prompts.
#[tauri::command]
pub async fn load_prompts(state: State<'_, AppState>) -> Result<Vec<PromptItem>, String> {
    Ok(state.config_manager.load_prompts())
}

/// Save prompts and reload shortcuts so prompt hotkeys take effect immediately.
#[tauri::command]
pub async fn save_prompts(
    app: AppHandle,
    state: State<'_, AppState>,
    prompts: Vec<PromptItem>,
) -> Result<serde_json::Value, String> {
    state.config_manager.save_prompts(&prompts)?;

    // Reload shortcuts so changed prompt hotkeys take effect immediately
    crate::reload_hotkey_bindings(&app);

    Ok(serde_json::json!({ "ok": true }))
}

/// Get usage statistics.
#[tauri::command]
pub async fn get_stats(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let stats = state.stats.lock().await;
    Ok(serde_json::to_value(stats.get_stats()).unwrap_or_default())
}

/// Get usage history.
#[tauri::command]
pub async fn get_history(
    state: State<'_, AppState>,
    days_back: u32,
) -> Result<serde_json::Value, String> {
    let stats = state.stats.lock().await;
    Ok(serde_json::to_value(stats.get_history(days_back)).unwrap_or_default())
}

/// Delete a history entry.
#[tauri::command]
pub async fn delete_history(
    state: State<'_, AppState>,
    ts: String,
) -> Result<serde_json::Value, String> {
    let mut stats = state.stats.lock().await;
    stats.delete_history(&ts);
    Ok(serde_json::json!({ "ok": true }))
}

/// Receive an audio chunk from the renderer (base64-encoded PCM).
#[tauri::command]
pub async fn send_audio_chunk(
    _app: AppHandle,
    state: State<'_, AppState>,
    base64_chunk: String,
) -> Result<serde_json::Value, String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static CHUNK_COUNT: AtomicU64 = AtomicU64::new(0);
    let n = CHUNK_COUNT.fetch_add(1, Ordering::Relaxed);
    if n == 0 || n % 50 == 0 {
        log_audio!(debug, "Received chunk #{} ({} bytes base64)", n, base64_chunk.len());
    }

    let session = state.asr_session.lock().await;
    if let Some(ref session) = *session {
        if session.is_ready() {
            session.append_audio(&base64_chunk);
            return Ok(serde_json::json!({ "ok": true }));
        }
        log_audio!(warn, "Chunk #{} dropped: session not ready", n);
    } else {
        if n == 0 {
            log_audio!(warn, "Chunk #{} dropped: no session", n);
        }
    }
    Ok(serde_json::json!({ "ok": false, "message": "ASR 会话未建立" }))
}

/// Notify that audio has stopped in the renderer.
#[tauri::command]
pub async fn audio_stopped(state: State<'_, AppState>) -> Result<(), String> {
    let mut pending = state.pending_audio_stop.lock().await;
    if let Some(tx) = pending.take() {
        let _ = tx.send(());
    }
    Ok(())
}

/// Notify that audio warmup is ready.
#[tauri::command]
pub async fn audio_warmup_ready(_app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let mut pending = state.pending_audio_warmup.lock().await;
    if let Some(tx) = pending.take() {
        let _ = tx.send(());
    }
    Ok(())
}

/// Notify that audio warmup failed.
#[tauri::command]
pub async fn audio_warmup_failed(
    _app: AppHandle,
    state: State<'_, AppState>,
    message: String,
) -> Result<(), String> {
    log_audio!(error, "Audio warmup failed: {}", message);
    let mut pending = state.pending_audio_warmup.lock().await;
    if let Some(tx) = pending.take() {
        drop(tx);
    }
    Ok(())
}

/// Send diagnostic info from renderer.
#[tauri::command]
pub async fn send_diagnostic(
    _state: State<'_, AppState>,
    payload: serde_json::Value,
) -> Result<(), String> {
    let msg = serde_json::to_string(&payload).unwrap_or_default();
    log_app!(info, "Renderer diagnostic: {}", msg);
    Ok(())
}

/// Paste text to focused element. This writes to clipboard and simulates paste.
#[tauri::command]
pub async fn paste_text(
    app: AppHandle,
    text: String,
    keep_clipboard: bool,
) -> Result<PasteResult, String> {
    // Write to clipboard using Tauri clipboard plugin
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard()
        .write_text(&text)
        .map_err(|e| format!("Failed to write to clipboard: {}", e))?;

    // Simulate paste keystroke
    let result = paste::simulate_paste();

    // Restore previous clipboard if needed
    if !keep_clipboard {
        // The clipboard already has the text, user may want it to stay
    }

    Ok(result)
}

/// Get microphone permission status via macOS AVFoundation.
/// Returns the real TCC authorization status on macOS; on other platforms
/// delegates to the WebView frontend.
#[tauri::command]
pub async fn get_microphone_status() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "status": check_microphone() }))
}

/// Check microphone permission via AVCaptureDevice authorization status.
#[cfg(target_os = "macos")]
fn check_microphone() -> &'static str {
    use objc2::{class, msg_send};

    // AVMediaTypeAudio is a framework NSString constant → @"soun"
    extern "C" {
        static AVMediaTypeAudio: *const objc2::runtime::AnyObject;
    }

    let status: isize = unsafe {
        msg_send![
            class!(AVCaptureDevice),
            authorizationStatusForMediaType: AVMediaTypeAudio
        ]
    };

    // AVAuthorizationStatus values
    match status {
        0 => "prompt",     // AVAuthorizationStatusNotDetermined — never asked
        1 => "restricted", // AVAuthorizationStatusRestricted — parental / MDM
        2 => "denied",     // AVAuthorizationStatusDenied — user refused
        3 => "granted",    // AVAuthorizationStatusAuthorized
        _ => "unknown",
    }
}

#[cfg(not(target_os = "macos"))]
fn check_microphone() -> &'static str {
    // On non-macOS platforms the WebView getUserMedia flow handles this
    "granted"
}

/// Request microphone access.
#[tauri::command]
pub async fn request_microphone_access() -> Result<serde_json::Value, String> {
    // In Tauri, this is handled by getUserMedia in the frontend
    Ok(serde_json::json!({ "status": "granted", "granted": true }))
}

/// Check the real accessibility permission status on macOS via AXIsProcessTrusted.
#[cfg(target_os = "macos")]
fn check_accessibility() -> &'static str {
    extern "C" {
        fn AXIsProcessTrusted() -> u8;
    }
    if unsafe { AXIsProcessTrusted() != 0 } {
        "granted"
    } else {
        "denied"
    }
}

#[cfg(not(target_os = "macos"))]
fn check_accessibility() -> &'static str {
    "granted"
}

/// Get accessibility status (macOS only).
#[tauri::command]
pub async fn get_accessibility_status() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "status": check_accessibility() }))
}

/// Open accessibility settings (macOS only).
#[tauri::command]
pub async fn open_accessibility_settings(app: AppHandle) -> Result<(), String> {
    #[allow(deprecated)]
    {
        use tauri_plugin_shell::ShellExt;
        app.shell()
            .open(
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
                None,
            )
            .map_err(|e| format!("Failed to open accessibility settings: {}", e))
    }
}

/// Try to start the keytap listener if it was skipped at startup due to
/// missing accessibility permission.  Call this after the user grants
/// permission in System Settings and returns to the app.
#[tauri::command]
pub async fn reinit_hotkey(app: AppHandle) -> Result<serde_json::Value, String> {
    let Some(config) = app.try_state::<crate::hotkey::HotkeyConfig>() else {
        return Ok(serde_json::json!({ "active": false, "reason": "no-config" }));
    };
    let active = crate::hotkey::ensure_hotkey_active(&config, &app);
    Ok(serde_json::json!({ "active": active }))
}

/// Select a sound file via file dialog.
#[tauri::command]
pub async fn select_sound_file(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let file_path = app
        .dialog()
        .file()
        .add_filter("音频文件", &["mp3", "wav", "ogg", "m4a", "aac", "flac"])
        .blocking_pick_file();
    Ok(file_path.map(|p| p.to_string()))
}

/// Play a sound.
#[tauri::command]
pub async fn play_sound_file(file_path: String) -> Result<(), String> {
    paste::play_sound(&file_path);
    Ok(())
}

/// Get the log file path.
#[tauri::command]
pub async fn get_log_path(state: State<'_, AppState>) -> Result<String, String> {
    Ok(state.log_path.to_string_lossy().to_string())
}

/// Get the config file path.
#[tauri::command]
pub async fn get_config_path(state: State<'_, AppState>) -> Result<String, String> {
    Ok(state
        .config_manager
        .config_path()
        .to_string_lossy()
        .to_string())
}
