use std::process::Command;
use std::thread;
use std::time::Duration;

#[derive(serde::Serialize)]
pub struct PasteResult {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    permission_error: Option<String>,
}

/// Simulate paste keystroke (Cmd+V / Ctrl+V) to the currently focused element.
/// Clipboard write is handled by the caller (command handler or recording lifecycle).
pub fn simulate_paste() -> PasteResult {
    // Use Tauri clipboard plugin via a simple approach:
    // Write to clipboard via pbcopy/clip, then simulate paste via osascript/PowerShell.
    // In the actual Tauri app, clipboard write is done via the plugin, and paste simulation is done here.

    // For the paste simulation part only (clipboard write is handled by the Tauri command):
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
                    "模拟粘贴失败，请检查当前焦点位置".to_string()
                } else {
                    msg
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

    // Give the target app a brief moment to read the clipboard
    thread::sleep(Duration::from_millis(120));

    Ok(())
}

fn simulate_paste_windows() -> Result<(), String> {
    let script = "(New-Object -ComObject WScript.Shell).SendKeys('^v')";
    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output()
        .map_err(|e| format!("Failed to run PowerShell: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(stderr);
    }

    thread::sleep(Duration::from_millis(120));

    Ok(())
}

/// Play a sound file using the system's native audio player.
pub fn play_sound(file_path: &str) {
    if file_path.is_empty() {
        return;
    }

    if cfg!(target_os = "macos") {
        if let Ok(mut child) = Command::new("afplay").arg(file_path).spawn() {
            thread::spawn(move || {
                let _ = child.wait();
            });
        }
    } else {
        let escaped = file_path.replace('\'', "''");
        let script = format!("(New-Object Media.SoundPlayer '{}').PlaySync()", escaped);
        if let Ok(mut child) = Command::new("powershell.exe")
            .args(["-NoProfile", "-Command", &script])
            .spawn()
        {
            thread::spawn(move || {
                let _ = child.wait();
            });
        }
    }
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
            message: Some("模拟粘贴失败".to_string()),
            permission_error: None,
        };
        assert!(!result.ok);
        assert_eq!(result.message.as_deref(), Some("模拟粘贴失败"));
    }

    #[test]
    fn paste_result_accessibility_error() {
        let result = PasteResult {
            ok: false,
            message: Some("not allowed".to_string()),
            permission_error: Some("accessibility".to_string()),
        };
        assert!(result.permission_error.is_some());
        assert_eq!(result.permission_error.as_deref(), Some("accessibility"));
    }

    #[test]
    fn paste_result_non_accessibility_error() {
        let result = PasteResult {
            ok: false,
            message: Some("generic error".to_string()),
            permission_error: None,
        };
        assert!(result.permission_error.is_none());
    }

    #[test]
    fn play_sound_empty_path_returns_early() {
        // Should not panic on empty path
        play_sound("");
    }
}
