//! Hotkey display labels for the settings UI.

use std::sync::Arc;

use crate::app_state::AppInner;

/// Map one accelerator token to the display label the settings UI shows.
/// Mirrors the frontend `normalizeHotkeyLabel` so the overlay label matches
/// system settings. Compiled per target OS: macOS renders Apple symbols
/// (⌃ ⇧ ⌥ ⌘), Windows renders its native labels (Ctrl / Shift / Alt / Win).
pub fn normalize_hotkey_key(key: &str) -> &str {
    // [windows_label, macos_symbol], indexed by the compiled target OS.
    let idx = cfg!(target_os = "macos") as usize;
    match key {
        // CmdOrCtrl resolves to Ctrl on Windows (accelerator convention).
        "CmdOrCtrl" | "CommandOrControl" | "Command" | "Cmd" | "Meta" => ["Ctrl", "⌘"][idx],
        "Control" | "Ctrl" => ["Ctrl", "⌃"][idx],
        "Shift" => ["Shift", "⇧"][idx],
        "Alt" | "Option" => ["Alt", "⌥"][idx],
        "Space" => "␣",
        "ControlLeft" => ["L Ctrl", "L ⌃"][idx],
        "ControlRight" => ["R Ctrl", "R ⌃"][idx],
        "ShiftLeft" => ["L Shift", "L ⇧"][idx],
        "ShiftRight" => ["R Shift", "R ⇧"][idx],
        "AltLeft" => ["L Alt", "L ⌥"][idx],
        "AltRight" => ["R Alt", "R ⌥"][idx],
        "MetaLeft" => ["L Win", "L ⌘"][idx],
        "MetaRight" => ["R Win", "R ⌘"][idx],
        other => other,
    }
}

/// Format an accelerator string ("AltRight", "Control+Space") into the display
/// label shown in settings. Per-platform via `normalize_hotkey_key`: macOS
/// ("R ⌥", "⌃ ␣"), Windows ("R Alt", "Ctrl ␣").
pub fn format_hotkey_label(hotkey: &str) -> String {
    hotkey
        .split('+')
        .map(|k| normalize_hotkey_key(k.trim()))
        .collect::<Vec<_>>()
        .join(" ")
}

/// The configured main hotkey, formatted for display. Empty for recorded keycode
/// sequences (which have no stable accelerator string).
pub async fn current_hotkey_label(app_inner: &Arc<AppInner>) -> String {
    let Ok(config) = app_inner.config_manager.load_config() else {
        return String::new();
    };
    match &config.app.hotkey {
        serde_norway::Value::String(s) => format_hotkey_label(s),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::format_hotkey_label;

    #[test]
    fn function_key_passes_through() {
        assert_eq!(format_hotkey_label("F13"), "F13");
    }

    #[test]
    fn sided_modifier_matches_settings_symbol() {
        // Mirrors the frontend normalizeHotkeyLabel.
        if cfg!(target_os = "macos") {
            assert_eq!(format_hotkey_label("AltRight"), "R ⌥");
        } else {
            assert_eq!(format_hotkey_label("AltRight"), "R Alt");
        }
    }

    #[test]
    fn combo_is_symbolized_and_joined() {
        if cfg!(target_os = "macos") {
            assert_eq!(format_hotkey_label("Control+Space"), "⌃ ␣");
            assert_eq!(format_hotkey_label("CmdOrCtrl+Shift+A"), "⌘ ⇧ A");
        } else {
            assert_eq!(format_hotkey_label("Control+Space"), "Ctrl ␣");
            assert_eq!(format_hotkey_label("CmdOrCtrl+Shift+A"), "Ctrl Shift A");
        }
    }

    #[test]
    fn empty_stays_empty() {
        assert_eq!(format_hotkey_label(""), "");
    }
}
