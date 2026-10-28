use crate::app_state::AppHandle as AppState;
use crate::app_state::HotkeyMode;
use crate::config::{AsrDefaults, PromptItem};
use crate::hotword::HotwordData;
use crate::model;
use tauri::{utils::Theme, AppHandle, Emitter, Manager, State};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// Cap on audio chunks buffered before the ASR session is ready (~100ms per
/// chunk, so ~30s). Bounds memory if the connect keeps failing.
const MAX_PENDING_CHUNKS: usize = 300;

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
        // CREATE_NO_WINDOW prevents reg.exe from flashing a console window
        // when our GUI-subsystem release build spawns it.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut cmd = std::process::Command::new("reg");
        cmd.args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
            "/v",
            "AppsUseLightTheme",
        ])
        .creation_flags(CREATE_NO_WINDOW);
        // Check registry: AppsUseLightTheme DWORD — 0 = dark, 1 = light.
        if let Ok(output) = cmd.output() {
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

pub(crate) fn apply_app_theme(app: &AppHandle, preference: &str) {
    let theme = match preference {
        "light" => Some(Theme::Light),
        "dark" => Some(Theme::Dark),
        _ => None,
    };
    app.set_theme(theme);
}

/// Current UI language (already resolved, so `auto` reflects the OS locale)
/// for frontend i18n bootstrapping.
#[tauri::command]
pub fn get_app_language(state: State<'_, AppState>) -> String {
    state.language.read().unwrap().code().to_string()
}

/// Get app configuration for the overlay.
#[tauri::command]
pub async fn get_app_config(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let config = state.config_manager.load_config()?;
    let hotkey = match &config.app.hotkey {
        serde_norway::Value::String(s) => s.clone(),
        serde_norway::Value::Sequence(arr) => {
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

/// Overlay pill layout constants, shared with the macOS native renderer via
/// `overlay::shared`. The Windows WebView fetches these once at startup so both
/// pills size identically (text width is still measured in the DOM).
#[tauri::command]
pub async fn get_overlay_layout_metrics() -> Result<crate::overlay::shared::LayoutMetrics, String> {
    Ok(crate::overlay::shared::LayoutMetrics::current())
}

/// Get audio config defaults used as runtime fallback.
#[tauri::command]
pub async fn get_audio_config_defaults() -> Result<serde_json::Value, String> {
    serde_json::to_value(AsrDefaults::default())
        .map_err(|e| format!("Failed to serialize audio defaults: {}", e))
}

/// Get settings data for the settings window.
#[tauri::command]
pub async fn get_settings_data(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let config = state.config_manager.load_config()?;
    let parsed_config = state.config_manager.get_editable_config()?;

    let hotkey = match &config.app.hotkey {
        serde_norway::Value::String(s) => s.clone(),
        serde_norway::Value::Sequence(arr) => {
            let keys: Vec<String> = arr
                .iter()
                .filter_map(|v| v.as_u64().map(|n| n.to_string()))
                .collect();
            keys.join("+")
        }
        _ => String::new(),
    };

    let version = env!("CARGO_PKG_VERSION").to_string();

    // Read theme from disk (parsed_config) to avoid stale cache after save
    let theme_preference = parsed_config
        .get("app")
        .and_then(|v| v.get("theme"))
        .and_then(|v| v.as_str())
        .unwrap_or("system")
        .to_string();

    Ok(serde_json::json!({
        "configPath": state.config_manager.config_path().to_string_lossy(),
        "parsedConfig": parsed_config,
        "runtime": {
            "hotkey": hotkey,
            "hotkeyDisplay": hotkey,
            "microphoneStatus": check_microphone(),
            "accessibilityStatus": check_accessibility(),
            "version": version,
            "platform": std::env::consts::OS,
            "hotkeyIssues": crate::hotkey::compile_bindings(&config.app, &state.config_manager.load_prompts()).1,
            "theme": {
                "preference": theme_preference.clone(),
                "resolved": resolve_theme(&theme_preference),
            },
        },
    }))
}

/// Save config as a parsed object.
#[tauri::command]
pub async fn save_config_object(
    app: AppHandle,
    state: State<'_, AppState>,
    config_object: serde_norway::Value,
) -> Result<serde_json::Value, String> {
    state.config_manager.save_config(&config_object)?;

    // Sync hotkey mode from saved config
    let updated_config = state.config_manager.load_config()?;
    apply_app_theme(&app, &updated_config.app.theme);

    // Sync UI language: update shared state, rebuild the tray, and let both
    // overlay renderers re-render through the appearance event below.
    let new_language = crate::lang::Language::resolve(&updated_config.app.language);
    if *state.language.read().unwrap() != new_language {
        *state.language.write().unwrap() = new_language;
        crate::rebuild_tray_menu(&app, new_language);
    }

    if let Some(hotkey_mode) = app.try_state::<HotkeyMode>() {
        *hotkey_mode.0.lock().unwrap() = updated_config.app.hotkey_mode.clone();
    }

    // Re-register shortcuts with the new hotkey from the config object
    crate::hotkey::reload_hotkey_bindings(&app);

    // Notify the overlay so it can re-apply the glass appearance live.
    let _ = app.emit(
        "overlay:event",
        serde_json::json!({
            "type": "appearance",
            "payload": {
                "platform": std::env::consts::OS,
                "overlayStyle": updated_config.app.overlay_style,
                "theme": updated_config.app.theme,
                "language": new_language.code(),
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

    let parsed = state.config_manager.get_editable_config()?;
    let config = state.config_manager.load_config()?;
    let hotkey = match &config.app.hotkey {
        serde_norway::Value::String(s) => s.clone(),
        _ => String::new(),
    };

    Ok(serde_json::json!({
        "ok": true,
        "parsedConfig": parsed,
        "runtime": {
            "hotkey": hotkey,
            "hotkeyDisplay": hotkey,
        },
    }))
}

/// Preview a complete shortcut change before the UI commits it.
#[tauri::command]
pub async fn validate_hotkey_settings(
    state: State<'_, AppState>,
    config_object: serde_norway::Value,
    prompts: Vec<PromptItem>,
    target_id: Option<String>,
) -> Result<(), String> {
    let candidate: crate::config::AppConfig =
        serde_norway::from_value(config_object).map_err(|e| format!("配置格式错误：{e}"))?;
    if let Some(target) = target_id {
        crate::hotkey::validate_target(&candidate.app, &prompts, &target)?;
    }
    crate::hotkey::validate_change(
        &candidate.app,
        &prompts,
        &state.config_manager.load_config()?.app,
        &state.config_manager.load_prompts(),
    )
}

/// Load prompts.
#[tauri::command]
pub async fn load_prompts(state: State<'_, AppState>) -> Result<Vec<PromptItem>, String> {
    Ok(state.config_manager.load_prompts())
}

/// Load built-in prompt templates from the bundled app resource (read-only).
/// Used by the "常用润色提示词" picker; never touches user data.
#[tauri::command]
pub async fn load_builtin_prompts(state: State<'_, AppState>) -> Result<Vec<PromptItem>, String> {
    Ok(state.config_manager.load_builtin_prompts())
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
    crate::hotkey::reload_hotkey_bindings(&app);

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

/// Retry a failed history entry by replaying its saved WAV through ASR.
#[tauri::command]
pub async fn retry_history_transcription(
    app: AppHandle,
    ts: String,
) -> Result<serde_json::Value, crate::errors::AppError> {
    crate::recording::retry_history_transcription(app, ts).await
}

/// Retry the latest failed recording from the overlay retry button.
#[tauri::command]
pub async fn retry_latest_failed_transcription(
    app: AppHandle,
) -> Result<serde_json::Value, crate::errors::AppError> {
    crate::recording::retry_latest_failed_transcription(app).await
}

/// Retry a parked polish from the overlay retry button. Returns false when
/// nothing was pending (or a retry is already in flight), so the caller can
/// fall back to the transcription retry.
#[tauri::command]
pub async fn retry_pending_polish(app: AppHandle) -> Result<bool, String> {
    Ok(crate::recording::retry_pending_polish(app).await)
}

/// Re-run LLM polishing on a history entry, rewriting its text in place.
/// `prompt_id` selects the template; omitted, the entry's own template is used.
#[tauri::command]
pub async fn repolish_history_entry(
    app: tauri::AppHandle,
    ts: String,
    prompt_id: Option<String>,
) -> Result<serde_json::Value, crate::errors::AppError> {
    crate::recording::repolish_history_entry(app, ts, prompt_id).await
}

/// Regenerate a successful history entry by re-transcribing its kept recording,
/// rewriting the entry's text in place. Silent: no overlay, paste, or app-state
/// change. Requires the entry to have a saved recording (keep-recording on).
#[tauri::command]
pub async fn regenerate_history_transcription(
    app: AppHandle,
    ts: String,
) -> Result<serde_json::Value, crate::errors::AppError> {
    crate::recording::regenerate_history_transcription(app, ts).await
}

pub(crate) async fn append_audio_samples(
    app: &AppHandle,
    state: &AppState,
    samples: Vec<f32>,
) -> bool {
    use std::sync::atomic::{AtomicU64, Ordering};
    static CHUNK_COUNT: AtomicU64 = AtomicU64::new(0);
    let n = CHUNK_COUNT.fetch_add(1, Ordering::Relaxed);
    if n == 0 || n.is_multiple_of(50) {
        log_audio!(
            debug,
            "Received audio chunk #{} ({} samples)",
            n,
            samples.len()
        );
    }

    state
        .recording_audio
        .lock()
        .await
        .extend_from_slice(&samples);

    // Both renderers gate their local animation from the same sound detector.
    if !samples.is_empty() {
        let active = state
            .wave_activity
            .lock()
            .await
            .update(&samples, std::time::Instant::now());
        let _ = app.emit(
            "overlay:event",
            serde_json::json!({
                "type": "audio:level",
                "payload": { "active": active }
            }),
        );
    }

    if !samples.is_empty() {
        let signal = crate::recording::audio_chunk_has_signal(&samples);
        let mut hints = state.recording_hints.lock().await;
        if let Some(hints) = hints.as_mut() {
            if hints.update(signal, std::time::Instant::now()) {
                crate::overlay::emit_shortcuts(app, &hints.shortcuts);
            }
        }
    }

    // Hold the `asr_session` lock across the decision so buffering stays ordered
    // against the background connect task's drain (same lock), guaranteeing no
    // buffered chunk is silently dropped between drain and session-attach.
    let session = state.asr_session.lock().await;
    if let Some(ref session) = *session {
        if session.is_ready() {
            session.append_audio(&samples);
            return false;
        }
    }

    // Session not ready yet (background connect in progress, or reconnect gap):
    // buffer the samples so nothing the user says before the session attaches is
    // lost. Drained into the session once it attaches.
    let mut pending = state.pending_audio.lock().await;
    if pending.len() < MAX_PENDING_CHUNKS {
        pending.push(samples);
        return true;
    } else if n.is_multiple_of(50) {
        log_audio!(
            warn,
            "Pending audio buffer full ({} chunks), dropping chunk #{}",
            MAX_PENDING_CHUNKS,
            n
        );
    }
    true
}

/// Cap the renderer diagnostic preview so a large payload (stack trace with
/// context) cannot flood the log file.
const RENDERER_DIAGNOSTIC_PREVIEW_CHARS: usize = 500;

/// Send diagnostic info from renderer.
#[tauri::command]
pub async fn send_diagnostic(
    _state: State<'_, AppState>,
    payload: serde_json::Value,
) -> Result<(), String> {
    // Redact credential-shaped pairs: the payload may carry provider error
    // text that echoes credentials, and this channel is the only way to
    // debug renderer issues from a submitted log file.
    let msg = serde_json::to_string(&payload).unwrap_or_default();
    let preview: String = msg
        .chars()
        .take(RENDERER_DIAGNOSTIC_PREVIEW_CHARS)
        .collect();
    log_app!(
        info,
        "Renderer diagnostic: {}",
        crate::logger::redact_credentials(&preview, &[])
    );
    Ok(())
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
pub async fn open_accessibility_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
            .status()
            .map_err(|e| format!("Failed to open accessibility settings: {}", e))?;
        if !status.success() {
            return Err(format!("Failed to open accessibility settings: {}", status));
        }
    }
    Ok(())
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

/// Result of recording a hotkey via the backend keytap tap. Mirrors the
/// frontend `HotkeyRecordResult` shape: `keys` is a single-element array
/// holding the full combination string (e.g. `["Fn"]`, `["ControlLeft+A"]`).
#[derive(serde::Serialize)]
pub struct HotkeyRecordResult {
    pub keys: Vec<String>,
    #[serde(rename = "displayString")]
    pub display_string: String,
    pub hotkey: Option<String>,
    /// Present only for `scope: "main"` recordings rejected because their
    /// first key pressed was a typing key. The settings page briefly shows
    /// the recording, then reverts to the previous hotkey and toasts this
    /// reason. Prompt-stop-key recordings (`scope: "prompt"`) never set it —
    /// their keys only act while a recording runs.
    #[serde(rename = "invalidReason")]
    pub invalid_reason: Option<String>,
}

/// Toast copy shown when a main-hotkey recording starts with a typing key.
const MAIN_HOTKEY_FIRST_KEY_HINT: &str =
    "为不影响键盘输入，主键第一个按键需为功能键、Tab 或修饰键（Ctrl/⌘/Shift/Option/Fn）";

/// Record a hotkey combination via events from the resident keytap listener.
/// Unlike a DOM keydown listener this captures keys the WebView never
/// sees (e.g. the macOS Fn/Globe key). Blocks on a worker thread for up to
/// ~10s; resolves with an empty result on Escape or timeout. `scope` selects
/// whether the first-pressed-key rule applies (`"main"` — it does; `"prompt"`
/// — it does not: prompt stop keys are legal as bare typing keys).
#[tauri::command]
pub async fn record_hotkey(
    app: AppHandle,
    scope: Option<String>,
) -> Result<HotkeyRecordResult, String> {
    let config = app
        .try_state::<crate::hotkey::HotkeyConfig>()
        .map(|c| c.inner().clone())
        .ok_or_else(|| {
            log_hotkey!(error, "record_hotkey: HotkeyConfig not in managed state");
            "hotkey system not initialized".to_string()
        })?;
    let session = uuid::Uuid::new_v4().to_string();
    let worker_session = session.clone();
    log_hotkey!(
        info,
        "recorder session={} stage=request scope={}",
        session,
        scope.as_deref().unwrap_or("prompt")
    );
    let result = tokio::task::spawn_blocking(move || {
        crate::hotkey::record_combination(
            &config,
            std::time::Duration::from_secs(10),
            &worker_session,
        )
    })
    .await
    .map_err(|e| {
        log_hotkey!(
            error,
            "recorder session={} outcome=worker_panicked error={}",
            session,
            e
        );
        format!("record_hotkey worker panicked: {e}")
    })?;

    let validate_main = scope.as_deref() == Some("main");
    Ok(match result {
        Some(recorded) => {
            let invalid_reason =
                if validate_main && !crate::hotkey::is_valid_main_first_key(recorded.first_key) {
                    Some(MAIN_HOTKEY_FIRST_KEY_HINT.to_string())
                } else {
                    None
                };
            log_hotkey!(
                info,
                "recorder session={} stage=response combo={} first_key={:?} accepted={} invalid_reason={:?}",
                session,
                recorded.combo,
                recorded.first_key,
                invalid_reason.is_none(),
                invalid_reason
            );
            HotkeyRecordResult {
                keys: vec![recorded.combo.clone()],
                display_string: recorded.combo.clone(),
                hotkey: Some(recorded.combo),
                invalid_reason,
            }
        }
        None => {
            log_hotkey!(
                info,
                "recorder session={} stage=response result=empty",
                session
            );
            HotkeyRecordResult {
                keys: vec![],
                display_string: String::new(),
                hotkey: None,
                invalid_reason: None,
            }
        }
    })
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

/// Start previewing a recording, replacing any preview already playing. Emits
/// `preview:ended` when playback finishes on its own or fails to start, so the
/// settings history list can return its button to the play state. A preview
/// that is stopped or replaced emits nothing — the caller already reset its
/// button when it issued the stop/replace.
#[tauri::command]
pub async fn play_recording_preview(
    app: tauri::AppHandle,
    file_path: String,
) -> Result<(), String> {
    use tauri::Emitter;
    crate::sound::play_preview_file(&file_path, move || {
        let _ = app.emit("preview:ended", ());
    });
    Ok(())
}

/// Stop the recording preview currently playing, if any.
#[tauri::command]
pub async fn stop_recording_preview() -> Result<(), String> {
    crate::sound::stop_preview();
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

/// Load hotword library.
#[tauri::command]
pub async fn load_hotwords(state: State<'_, AppState>) -> Result<HotwordData, String> {
    Ok(state.hotword_manager.load())
}

/// Save hotword library.
#[tauri::command]
pub async fn save_hotwords(
    state: State<'_, AppState>,
    data: HotwordData,
) -> Result<serde_json::Value, String> {
    state.hotword_manager.save(&data)?;

    Ok(serde_json::json!({ "ok": true }))
}

/// Load built-in hotword tables from the bundled app resource (read-only).
/// Used by the "常用热词表" picker; never touches user data.
#[tauri::command]
pub async fn load_builtin_hotwords(state: State<'_, AppState>) -> Result<HotwordData, String> {
    Ok(state.hotword_manager.load_builtin())
}

// ---------------------------------------------------------------------------
// Model management commands
// ---------------------------------------------------------------------------

/// Get the model registry.
#[tauri::command]
pub async fn get_model_registry(app: AppHandle) -> Result<serde_json::Value, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve data dir: {}", e))?;
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to resolve resource dir: {}", e))?;
    let registry = model::load_registry(&data_dir, &resource_dir);
    serde_json::to_value(&registry).map_err(|e| format!("Failed to serialize registry: {}", e))
}

/// Get list of downloaded model IDs.
#[tauri::command]
pub async fn get_downloaded_models(app: AppHandle) -> Result<serde_json::Value, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve data dir: {}", e))?;
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to resolve resource dir: {}", e))?;
    let registry = model::load_registry(&data_dir, &resource_dir);
    let downloaded = model::get_downloaded_models(&data_dir, &registry);
    Ok(serde_json::json!({ "models": downloaded }))
}

/// Download a model by ID.
#[tauri::command]
pub async fn download_model(app: AppHandle, model_id: String) -> Result<serde_json::Value, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve data dir: {}", e))?;
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to resolve resource dir: {}", e))?;
    let registry = model::load_registry(&data_dir, &resource_dir);
    model::download_model(&app, &data_dir, &registry, &model_id).await?;
    Ok(serde_json::json!({ "ok": true }))
}

/// Delete a downloaded model.
#[tauri::command]
pub async fn delete_model(app: AppHandle, model_id: String) -> Result<serde_json::Value, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve data dir: {}", e))?;
    model::delete_model(&data_dir, &model_id)?;
    Ok(serde_json::json!({ "ok": true }))
}

/// Called after the WebView's exit animation; stale completions cannot hide a new session.
#[tauri::command]
pub fn complete_overlay_hide(app: AppHandle, generation: u64) {
    crate::overlay::complete_hide(&app, generation);
}
