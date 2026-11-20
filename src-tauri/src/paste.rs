use std::process::Command;
use std::thread;
use std::time::Duration;

use crate::errors::{AppError, AppErrorCode};

#[cfg(target_os = "macos")]
mod macos;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[derive(serde::Serialize)]
pub struct PasteResult {
    pub(crate) ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) message: Option<AppError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    permission_error: Option<String>,
}

/// Process creation flag that suppresses the console window Windows would
/// otherwise allocate when a GUI-subsystem process (our release build) spawns a
/// console child such as powershell/reg.
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Prevent the spawned child process from flashing a console window on Windows.
/// No-op on non-Windows, where these CLI tools never open a visible window.
fn hide_console(cmd: &mut Command) {
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    // Non-Windows: nothing to do.
    #[cfg(not(target_os = "windows"))]
    let _ = cmd;
}

pub(crate) fn paste_text(
    _app: &tauri::AppHandle,
    text: &str,
    keep_clipboard: bool,
) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    let result = macos::paste_text(text, keep_clipboard)?;
    #[cfg(not(target_os = "macos"))]
    let result = paste_with_clipboard(_app, text, keep_clipboard)?;

    if result.ok {
        Ok(())
    } else {
        Err(result
            .message
            .unwrap_or_else(|| AppError::new(AppErrorCode::PasteSimulationFailed)))
    }
}

#[cfg(not(target_os = "macos"))]
fn paste_with_clipboard(
    app: &tauri::AppHandle,
    text: &str,
    keep_clipboard: bool,
) -> Result<PasteResult, AppError> {
    use tauri_plugin_clipboard_manager::ClipboardExt;

    let clipboard = app.clipboard();
    let original = if keep_clipboard {
        None
    } else {
        clipboard.read_text().ok()
    };
    clipboard.write_text(text).map_err(|e| {
        AppError::new(AppErrorCode::PasteClipboardWriteFailed).with_detail(e.to_string())
    })?;

    let result = simulate_paste();
    if let Some(original) = original {
        if let Err(e) = clipboard.write_text(&original) {
            log_rec!(error, "Failed to restore clipboard: {}", e);
        }
    }
    Ok(result)
}

/// Send the paste keystroke to the currently focused element.
fn simulate_paste() -> PasteResult {
    let result = if cfg!(target_os = "macos") {
        simulate_paste_macos()
    } else {
        simulate_paste_windows()
    };

    match result {
        Ok(()) => PasteResult {
            ok: true,
            message: None,
            permission_error: None,
        },
        Err(e) => {
            let msg = e.to_string();
            let is_accessibility_error = cfg!(target_os = "macos")
                && (msg.contains("not allowed")
                    || msg.contains("not authorized")
                    || msg.contains("keystroke")
                    || msg.contains("apple event"));

            PasteResult {
                ok: false,
                message: Some(if msg.is_empty() {
                    AppError::new(AppErrorCode::PasteSimulationFailed)
                } else {
                    AppError::new(AppErrorCode::PasteSimulationFailed).with_detail(msg)
                }),
                permission_error: if is_accessibility_error {
                    Some("accessibility".to_string())
                } else {
                    None
                },
            }
        }
    }
}

fn simulate_paste_macos() -> Result<(), String> {
    let output = Command::new("osascript")
        .args([
            "-e",
            "tell application \"System Events\"",
            "-e",
            "keystroke \"v\" using command down",
            "-e",
            "end tell",
        ])
        .output()
        .map_err(|e| format!("Failed to run osascript: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(stderr);
    }

    Ok(())
}

fn simulate_paste_windows() -> Result<(), String> {
    let script = "(New-Object -ComObject WScript.Shell).SendKeys('^v')";
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", script]);
    hide_console(&mut cmd);
    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run PowerShell: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(stderr);
    }

    thread::sleep(Duration::from_millis(120));

    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paste_result_ok() {
        let result = PasteResult {
            ok: true,
            message: None,
            permission_error: None,
        };
        assert!(result.ok);
        assert!(result.message.is_none());
        assert!(result.permission_error.is_none());
    }

    #[test]
    fn paste_result_error_with_message() {
        let result = PasteResult {
            ok: false,
            message: Some(AppError::new(AppErrorCode::PasteSimulationFailed)),
            permission_error: None,
        };
        assert!(!result.ok);
        assert_eq!(
            result.message.unwrap().code,
            AppErrorCode::PasteSimulationFailed
        );
    }

    #[test]
    fn paste_result_accessibility_error() {
        let result = PasteResult {
            ok: false,
            message: Some(
                AppError::new(AppErrorCode::PasteSimulationFailed).with_detail("not allowed"),
            ),
            permission_error: Some("accessibility".to_string()),
        };
        assert!(result.permission_error.is_some());
        assert_eq!(result.permission_error.as_deref(), Some("accessibility"));
    }

    #[test]
    fn paste_result_non_accessibility_error() {
        let result = PasteResult {
            ok: false,
            message: Some(
                AppError::new(AppErrorCode::PasteSimulationFailed).with_detail("generic error"),
            ),
            permission_error: None,
        };
        assert!(result.permission_error.is_none());
    }
}
