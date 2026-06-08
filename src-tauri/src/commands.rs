use crate::app_state::AppHandle as AppState;
use crate::config::PromptItem;
use crate::paste;
use crate::HotkeyMode;
use tauri::{AppHandle, Manager, State};

// Re-export paste::PasteResult for use in commands
use paste::PasteResult;

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
        "glass": config.app.overlay_glass_mode,
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
            "microphoneStatus": "granted", // WebView handles mic permissions
            "accessibilityStatus": check_accessibility(),
            "version": version,
            "platform": std::env::consts::OS,
            "theme": {
                "preference": config.app.theme,
                "resolved": config.app.theme,
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

    let hotkey_str = match &updated_config.app.hotkey {
        serde_yaml::Value::String(s) => s.clone(),
        _ => String::new(),
    };
    crate::reload_shortcuts(&app, &hotkey_str).ok();

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
    let hotkey_str = match config_object.get("app").and_then(|a| a.get("hotkey")) {
        Some(serde_yaml::Value::String(s)) => s.clone(),
        _ => String::new(),
    };
    crate::reload_shortcuts(&app, &hotkey_str).ok();

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

/// Reset config to default.
#[tauri::command]
pub async fn reset_config(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    state.config_manager.reset_to_default()?;

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

/// Save prompts.
#[tauri::command]
pub async fn save_prompts(
    state: State<'_, AppState>,
    prompts: Vec<PromptItem>,
) -> Result<serde_json::Value, String> {
    state.config_manager.save_prompts(&prompts)?;
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
        eprintln!(
            "[audio] received chunk #{} ({} bytes base64)",
            n,
            base64_chunk.len()
        );
    }

    let session = state.asr_session.lock().await;
    if let Some(ref session) = *session {
        if session.is_ready() {
            session.append_audio(&base64_chunk);
            return Ok(serde_json::json!({ "ok": true }));
        }
        eprintln!("[audio] chunk #{} dropped: session not ready", n);
    } else {
        if n == 0 {
            eprintln!("[audio] chunk #{} dropped: no session", n);
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
    let mut logger = state.logger.lock().await;
    logger.error("audio warmup failed", Some(&message));
    let mut pending = state.pending_audio_warmup.lock().await;
    if let Some(tx) = pending.take() {
        drop(tx);
    }
    Ok(())
}

/// Send diagnostic info from renderer.
#[tauri::command]
pub async fn send_diagnostic(
    state: State<'_, AppState>,
    payload: serde_json::Value,
) -> Result<(), String> {
    let mut logger = state.logger.lock().await;
    let msg = serde_json::to_string(&payload).unwrap_or_default();
    logger.info("renderer diagnostic", Some(&msg));
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

/// Get microphone permission status.
#[tauri::command]
pub async fn get_microphone_status() -> Result<serde_json::Value, String> {
    // In Tauri/WebView, microphone access is handled by getUserMedia in the frontend
    Ok(serde_json::json!({ "status": "granted" }))
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
    let logger = state.logger.lock().await;
    Ok(logger.log_path().to_string_lossy().to_string())
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
