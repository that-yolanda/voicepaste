// Updater commands for Tauri's built-in update system.
// Provides check_for_update and download_and_install_update IPC commands.

use std::sync::Mutex;
use tauri::Emitter;
use tauri_plugin_updater::UpdaterExt;

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
/// Stores the Update object in PendingUpdate state for later download.
#[tauri::command]
pub async fn check_for_update(
    app: tauri::AppHandle,
    pending: tauri::State<'_, PendingUpdate>,
) -> Result<UpdateInfo, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater.check().await.map_err(|e| e.to_string())?;

    match update {
        Some(update) => {
            let info = UpdateInfo {
                available: true,
                version: Some(update.version.clone()),
                date: update.date.clone().map(|d| d.to_string()),
                notes: update.body.clone(),
            };
            *pending.0.lock().unwrap() = Some(update);
            Ok(info)
        }
        None => Ok(UpdateInfo {
            available: false,
            version: None,
            date: None,
            notes: None,
        }),
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
