// Updater commands for Tauri's built-in update system.
// Provides check_for_update and download_and_install_update IPC commands.
// Supports beta channel via config.app.beta_updates.

use std::sync::Mutex;
use tauri::Emitter;
use tauri_plugin_updater::UpdaterExt;

use crate::app_state::AppHandle as AppState;

/// Holds a pending update between check and download/install.
pub struct PendingUpdate(pub Mutex<Option<tauri_plugin_updater::Update>>);

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    available: bool,
    version: Option<String>,
    date: Option<String>,
    notes: Option<String>,
}

/// Check if an update is available.
/// Reads `app.beta_updates` from config to select stable or beta endpoint.
/// Stores the Update object in PendingUpdate state for later download.
#[tauri::command]
pub async fn check_for_update(
    app: tauri::AppHandle,
    pending: tauri::State<'_, PendingUpdate>,
    inner: tauri::State<'_, AppState>,
) -> Result<UpdateInfo, String> {
    let config = inner.config_manager.load_config().map_err(|e| e.to_string())?;
    let beta = config.app.beta_updates;

    let suffix = if beta { "-beta" } else { "" };
    let endpoint = format!(
        "https://github.com/that-yolanda/voicepaste/releases/latest/download/latest{suffix}.json"
    );

    log_update!(info, "Checking for{} updates via {}", if beta { " beta" } else { "" }, endpoint);

    let url = url::Url::parse(&endpoint)
        .map_err(|e| format!("Invalid update endpoint URL: {}", e))?;
    let update = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;

    match update {
        Some(update) => {
            let info = UpdateInfo {
                available: true,
                version: Some(update.version.clone()),
                date: update.date.clone().map(|d| d.to_string()),
                notes: update.body.clone(),
            };
            log_update!(info, "Update available: v{}", update.version);
            *pending.0.lock().unwrap() = Some(update);
            Ok(info)
        }
        None => {
            log_update!(info, "No update available");
            Ok(UpdateInfo {
                available: false,
                version: None,
                date: None,
                notes: None,
            })
        }
    }
}

/// Download and install the previously checked update.
/// Emits progress events: update:progress and update:finished.
#[tauri::command]
pub async fn download_and_install_update(
    app: tauri::AppHandle,
    pending: tauri::State<'_, PendingUpdate>,
) -> Result<(), String> {
    let update = pending
        .0
        .lock()
        .unwrap()
        .take()
        .ok_or("No update available. Run check_for_update first.")?;

    log_update!(info, "Downloading update v{}...", update.version);

    let mut downloaded: u64 = 0;

    update
        .download_and_install(
            |chunk_length, content_length| {
                downloaded += chunk_length as u64;
                let _ = app.emit(
                    "update:progress",
                    serde_json::json!({
                        "downloaded": downloaded,
                        "contentLength": content_length,
                    }),
                );
            },
            || {
                let _ = app.emit("update:finished", serde_json::json!({}));
            },
        )
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}
