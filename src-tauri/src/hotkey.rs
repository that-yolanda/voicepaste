//! Global hotkey management via keytap.
//!
//! Replaces `tauri-plugin-global-shortcut` with a raw keyboard event stream
//! that supports modifier-only hotkeys and left/right modifier distinction.

use crate::config::PromptItem;
use keytap::{EventKind, Key, Tap};
use std::collections::{BTreeSet, HashSet};
use std::sync::{Arc, RwLock};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// A registered hotkey binding: a set of keys + metadata.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HotkeyBinding {
    /// The set of keys that must all be held simultaneously.
    pub keys: BTreeSet<Key>,
    /// "toggle" or "hold".
    pub mode: String,
    /// `None` for the main hotkey, `Some(id)` for prompt hotkeys.
    pub prompt_id: Option<String>,
}

/// Shared hotkey configuration, updatable without restarting the tap.
#[derive(Debug)]
pub struct HotkeyConfigInner {
    /// All registered bindings (main + prompts).
    pub bindings: Vec<HotkeyBinding>,
    /// Whether escape-key cancellation is currently enabled.
    pub escape_enabled: bool,
    /// Whether the keytap listener thread is currently running.
    /// `false` when the tap could not be created (e.g. missing permissions).
    pub tap_active: bool,
}

/// Thread-safe handle to the hotkey configuration.
pub type HotkeyConfig = Arc<RwLock<HotkeyConfigInner>>;

/// Manages the keytap listener thread lifetime.
/// The Tap is owned by the listener thread; dropping this struct
/// does NOT stop the listener (it runs until the process exits).
/// This is intentional — global hotkeys must work for the full app lifetime.
pub struct HotkeyManager {
    _config: HotkeyConfig,
}

// ---------------------------------------------------------------------------
// Parsing: config string → BTreeSet<Key>
// ---------------------------------------------------------------------------

/// Parse a hotkey config string (e.g. "Control+Space", "F13", "RightShift")
/// into a set of keytap `Key`s.
///
/// Backward compatible: bare modifier names default to the left variant.
/// New syntax: "ControlLeft", "ShiftRight", etc. for side-specific keys.
pub fn parse_hotkey_string(s: &str) -> Option<BTreeSet<Key>> {
    let parts: Vec<&str> = s.split('+').map(|p| p.trim()).collect();
    if parts.is_empty() || parts.iter().all(|p| p.is_empty()) {
        return None;
    }

    let mut keys = BTreeSet::new();
    for part in parts {
        if part.is_empty() {
            continue;
        }
        let key = parse_single_key(part)?;
        keys.insert(key);
    }
    if keys.is_empty() {
        None
    } else {
        Some(keys)
    }
}

/// Map a single token to a keytap `Key`.
fn parse_single_key(part: &str) -> Option<Key> {
    let lower = part.to_lowercase();
    match lower.as_str() {
        // Backward-compatible bare modifier names → left variant
        "ctrl" | "control" => Some(Key::ControlLeft),
        "shift" => Some(Key::ShiftLeft),
        "alt" | "option" => Some(Key::AltLeft),
        "super" | "cmd" | "command" | "meta" => Some(Key::MetaLeft),
        "cmdorctrl" | "commandorcontrol" => {
            if cfg!(target_os = "macos") {
                Some(Key::MetaLeft)
            } else {
                Some(Key::ControlLeft)
            }
        }
        // Side-specific modifiers
        "controlleft" | "ctrlleft" | "leftctrl" | "leftcontrol" => Some(Key::ControlLeft),
        "controlright" | "ctrlright" | "rightctrl" | "rightcontrol" => Some(Key::ControlRight),
        "shiftleft" | "leftshift" => Some(Key::ShiftLeft),
        "shiftright" | "rightshift" => Some(Key::ShiftRight),
        "altleft" | "leftalt" | "leftoption" => Some(Key::AltLeft),
        "altright" | "rightalt" | "rightoption" => Some(Key::AltRight),
        "metaleft" | "cmdleft" | "commandleft" | "leftmeta" | "leftcmd" | "leftcommand" => {
            Some(Key::MetaLeft)
        }
        "metaright" | "cmdright" | "commandright" | "rightmeta" | "rightcmd" | "rightcommand" => {
            Some(Key::MetaRight)
        }
        // Special keys
        "space" => Some(Key::Space),
        "enter" | "return" => Some(Key::Enter),
        "tab" => Some(Key::Tab),
        "escape" | "esc" => Some(Key::Escape),
        "backspace" => Some(Key::Backspace),
        "up" | "arrowup" => Some(Key::ArrowUp),
        "down" | "arrowdown" => Some(Key::ArrowDown),
        "left" | "arrowleft" => Some(Key::ArrowLeft),
        "right" | "arrowright" => Some(Key::ArrowRight),
        "home" => Some(Key::Home),
        "end" => Some(Key::End),
        "pageup" => Some(Key::PageUp),
        "pagedown" => Some(Key::PageDown),
        "insert" => Some(Key::Insert),
        "delete" => Some(Key::Delete),
        "capslock" | "caps" => Some(Key::CapsLock),
        "menu" | "apps" => Some(Key::Menu),
        "printscreen" | "prtsc" => Some(Key::PrintScreen),
        "scrolllock" => Some(Key::ScrollLock),
        "pause" | "break" => Some(Key::Pause),
        "numlock" => Some(Key::NumLock),
        "backtick" | "grave" => Some(Key::Backtick),
        "minus" => Some(Key::Minus),
        "equal" | "equals" => Some(Key::Equal),
        "bracketleft" | "[" => Some(Key::BracketLeft),
        "bracketright" | "]" => Some(Key::BracketRight),
        "backslash" | "\\" => Some(Key::Backslash),
        "semicolon" | ";" => Some(Key::Semicolon),
        "quote" | "'" => Some(Key::Quote),
        "comma" | "," => Some(Key::Comma),
        "period" | "." => Some(Key::Period),
        "slash" | "/" => Some(Key::Slash),
        // Function keys (F1-F24, at least 2 chars)
        s if s.starts_with('f') && s.len() >= 2 && s.len() <= 3 => {
            if let Ok(n) = s[1..].parse::<u32>() {
                f_number_to_key(n)
            } else {
                None
            }
        }
        // Single letter keys (a-z)
        s if s.len() == 1 && s.chars().next().unwrap().is_ascii_alphabetic() => {
            letter_to_key(s.chars().next().unwrap())
        }
        // Single digit keys (0-9)
        s if s.len() == 1 && s.chars().next().unwrap().is_ascii_digit() => {
            digit_to_key(s.chars().next().unwrap())
        }
        _ => None,
    }
}

fn f_number_to_key(n: u32) -> Option<Key> {
    match n {
        1 => Some(Key::F1),
        2 => Some(Key::F2),
        3 => Some(Key::F3),
        4 => Some(Key::F4),
        5 => Some(Key::F5),
        6 => Some(Key::F6),
        7 => Some(Key::F7),
        8 => Some(Key::F8),
        9 => Some(Key::F9),
        10 => Some(Key::F10),
        11 => Some(Key::F11),
        12 => Some(Key::F12),
        13 => Some(Key::F13),
        14 => Some(Key::F14),
        15 => Some(Key::F15),
        16 => Some(Key::F16),
        17 => Some(Key::F17),
        18 => Some(Key::F18),
        19 => Some(Key::F19),
        20 => Some(Key::F20),
        21 => Some(Key::F21),
        22 => Some(Key::F22),
        23 => Some(Key::F23),
        24 => Some(Key::F24),
        _ => None,
    }
}

fn letter_to_key(c: char) -> Option<Key> {
    match c {
        'a' => Some(Key::A),
        'b' => Some(Key::B),
        'c' => Some(Key::C),
        'd' => Some(Key::D),
        'e' => Some(Key::E),
        'f' => Some(Key::F),
        'g' => Some(Key::G),
        'h' => Some(Key::H),
        'i' => Some(Key::I),
        'j' => Some(Key::J),
        'k' => Some(Key::K),
        'l' => Some(Key::L),
        'm' => Some(Key::M),
        'n' => Some(Key::N),
        'o' => Some(Key::O),
        'p' => Some(Key::P),
        'q' => Some(Key::Q),
        'r' => Some(Key::R),
        's' => Some(Key::S),
        't' => Some(Key::T),
        'u' => Some(Key::U),
        'v' => Some(Key::V),
        'w' => Some(Key::W),
        'x' => Some(Key::X),
        'y' => Some(Key::Y),
        'z' => Some(Key::Z),
        _ => None,
    }
}

fn digit_to_key(c: char) -> Option<Key> {
    match c {
        '0' => Some(Key::Digit0),
        '1' => Some(Key::Digit1),
        '2' => Some(Key::Digit2),
        '3' => Some(Key::Digit3),
        '4' => Some(Key::Digit4),
        '5' => Some(Key::Digit5),
        '6' => Some(Key::Digit6),
        '7' => Some(Key::Digit7),
        '8' => Some(Key::Digit8),
        '9' => Some(Key::Digit9),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Parsing: prompt hotkey value → BTreeSet<Key>
// ---------------------------------------------------------------------------

/// Parse a prompt hotkey YAML value that can be either:
/// - A string array like `["Control+Shift+A"]` (new format)
/// - A number array like `[29, 54, 4]` (legacy uIOhook format)
pub fn parse_prompt_hotkey_to_keys(hotkey: &serde_norway::Value) -> Option<BTreeSet<Key>> {
    let seq = hotkey.as_sequence()?;

    // Try string format first: ["Control+Shift+A"]
    if let Some(first) = seq.first() {
        if let Some(s) = first.as_str() {
            return parse_hotkey_string(s);
        }
    }

    // Fall back to uIOhook keycode format: [29, 54, 4]
    let keycodes: Vec<u32> = seq
        .iter()
        .filter_map(|v| v.as_u64().map(|n| n as u32))
        .collect();
    if keycodes.is_empty() {
        return None;
    }
    keycode_array_to_keys(&keycodes)
}

/// Convert a uIOhook keycode array to a set of keytap Keys.
/// Only modifiers and common special keys are mapped.
fn keycode_array_to_keys(keycodes: &[u32]) -> Option<BTreeSet<Key>> {
    let mut keys = BTreeSet::new();
    for &kc in keycodes {
        match keycode_to_key(kc) {
            Some(key) => {
                keys.insert(key);
            }
            None => {
                log_hotkey!(
                    warn,
                    "Unsupported uIOhook keycode 0x{:04X}, skipping prompt shortcut",
                    kc
                );
                return None;
            }
        }
    }
    if keys.is_empty() {
        None
    } else {
        Some(keys)
    }
}

/// Map a single uIOhook keycode to a keytap Key.
fn keycode_to_key(kc: u32) -> Option<Key> {
    match kc {
        // Modifiers
        0x001D | 0x009D => Some(Key::ControlLeft), // Left/Right Ctrl → left for legacy compat
        0x002E => Some(Key::ShiftLeft),             // Left Shift
        0x0036 => Some(Key::ShiftRight),            // Right Shift
        0x0038 => Some(Key::AltLeft),               // Left Alt
        0x0138 => Some(Key::AltRight),              // Right Alt
        0x0037 | 0x00D7 => Some(Key::MetaLeft),     // Left/Right Meta → left for legacy compat
        // Special keys
        0x0020 => Some(Key::Space),
        0x0028 => Some(Key::Enter),
        0x002A => Some(Key::Backspace),
        0x002B => Some(Key::Tab),
        0x0001 => Some(Key::Escape),
        // Function keys
        0x003B => Some(Key::F1),
        0x003C => Some(Key::F2),
        0x003D => Some(Key::F3),
        0x003E => Some(Key::F4),
        0x003F => Some(Key::F5),
        0x0040 => Some(Key::F6),
        0x0041 => Some(Key::F7),
        0x0042 => Some(Key::F8),
        0x0043 => Some(Key::F9),
        0x0044 => Some(Key::F10),
        0x0057 => Some(Key::F11),
        0x0058 => Some(Key::F12),
        // Letters
        0x0004 => Some(Key::A),
        0x0005 => Some(Key::B),
        0x0006 => Some(Key::C),
        0x0007 => Some(Key::D),
        0x0008 => Some(Key::E),
        0x0009 => Some(Key::F),
        0x000A => Some(Key::G),
        0x000B => Some(Key::H),
        0x000C => Some(Key::I),
        0x000D => Some(Key::J),
        0x000E => Some(Key::K),
        0x000F => Some(Key::L),
        0x0010 => Some(Key::M),
        0x0011 => Some(Key::N),
        0x0012 => Some(Key::O),
        0x0013 => Some(Key::P),
        0x0014 => Some(Key::Q),
        0x0015 => Some(Key::R),
        0x0016 => Some(Key::S),
        0x0017 => Some(Key::T),
        0x0018 => Some(Key::U),
        0x0019 => Some(Key::V),
        0x001A => Some(Key::W),
        0x001B => Some(Key::X),
        0x001C => Some(Key::Y),
        0x001E => Some(Key::Z),
        // Digits
        0x001F => Some(Key::Digit1),
        0x0021 => Some(Key::Digit2),
        0x0022 => Some(Key::Digit3),
        0x0023 => Some(Key::Digit4),
        0x0024 => Some(Key::Digit5),
        0x0025 => Some(Key::Digit6),
        0x0026 => Some(Key::Digit7),
        0x0027 => Some(Key::Digit8),
        0x0029 => Some(Key::Digit9),
        0x002C => Some(Key::Digit0),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Listener thread
// ---------------------------------------------------------------------------

/// Start the global hotkey listener thread.
///
/// Spawns a background thread that receives raw keyboard events from keytap
/// and dispatches matching hotkey events via the Tauri async runtime.
///
/// When accessibility/input-monitoring permission is not granted (macOS/Linux),
/// logs a warning and returns a manager *without* an active listener so the
/// app can still start. The user can grant permission later and restart.
pub fn start_hotkey_listener(
    config: HotkeyConfig,
    app_handle: tauri::AppHandle,
) -> Result<HotkeyManager, keytap::Error> {
    let tap = match Tap::new() {
        Ok(tap) => tap,
        Err(keytap::Error::PermissionDenied) => {
            log_hotkey!(warn, "Accessibility permission not granted — global hotkeys disabled");
            return Ok(HotkeyManager { _config: config });
        }
        Err(e) => {
            log_hotkey!(error, "keytap init failed: {:?} — global hotkeys disabled", e);
            return Ok(HotkeyManager { _config: config });
        }
    };

    let config_clone = config.clone();
    let handle_clone = app_handle.clone();

    std::thread::Builder::new()
        .name("voicepaste-hotkey".into())
        .spawn(move || {
            run_listener_loop(&tap, &config_clone, &handle_clone);
        })
        .expect("failed to spawn hotkey listener thread");

    config.write().unwrap().tap_active = true;

    Ok(HotkeyManager { _config: config })
}

/// Try to start the keytap listener if it is not already running.
///
/// Returns `true` if the listener is now active (either it was already
/// running, or we successfully created it post-startup).  Returns `false`
/// if the tap still cannot be created (e.g. permission still missing).
pub fn ensure_hotkey_active(config: &HotkeyConfig, app_handle: &tauri::AppHandle) -> bool {
    {
        let cfg = config.read().unwrap();
        if cfg.tap_active {
            return true;
        }
    }

    let tap = match Tap::new() {
        Ok(tap) => tap,
        Err(e) => {
            log_hotkey!(warn, "Still cannot create keytap: {:?}", e);
            return false;
        }
    };

    let config_clone = config.clone();
    let handle_clone = app_handle.clone();

    std::thread::Builder::new()
        .name("voicepaste-hotkey".into())
        .spawn(move || {
            run_listener_loop(&tap, &config_clone, &handle_clone);
        })
        .expect("failed to spawn hotkey listener thread");

    config.write().unwrap().tap_active = true;
    log_hotkey!(info, "Hotkey listener started (post-startup reinit)");
    true
}

/// Main loop for the listener thread.
fn run_listener_loop(tap: &Tap, config: &HotkeyConfig, app_handle: &tauri::AppHandle) {
    let mut held: HashSet<Key> = HashSet::new();
    let mut active_binding: Option<usize> = None;
    let mut escape_was_pressed = false;

    loop {
        match tap.recv_timeout(std::time::Duration::from_millis(100)) {
            Ok(event) => {
                let event_kind = event.kind;
                let key = match event_kind {
                    EventKind::KeyDown(k) => {
                        held.insert(k);
                        Some(k)
                    }
                    EventKind::KeyUp(k) => {
                        held.remove(&k);
                        Some(k)
                    }
                    EventKind::KeyRepeat(_) => None, // Ignore key repeats
                };

                if key.is_none() {
                    continue;
                }

                // Check escape cancellation
                let cfg = config.read().unwrap();
                if matches!(event_kind, EventKind::KeyUp(Key::Escape)) {
                    escape_was_pressed = false;
                }

                if cfg.escape_enabled && matches!(event_kind, EventKind::KeyDown(Key::Escape)) {
                    if !escape_was_pressed {
                        escape_was_pressed = true;
                        let handle = app_handle.clone();
                        tauri::async_runtime::spawn(async move {
                            crate::cancel_recording(handle).await;
                        });
                    }
                }

                // Match hotkey bindings
                let matched_idx = find_matching_binding(&held, &cfg.bindings);

                match (matched_idx, active_binding) {
                    // New binding activated (press)
                    (Some(new_idx), None) => {
                        active_binding = Some(new_idx);
                        let binding = &cfg.bindings[new_idx];
                        spawn_hotkey_pressed(
                            app_handle,
                            &binding.mode,
                            binding.prompt_id.clone(),
                        );
                    }
                    // Different binding activated (transition)
                    (Some(new_idx), Some(old_idx)) if new_idx != old_idx => {
                        let old = &cfg.bindings[old_idx];
                        spawn_hotkey_released(app_handle, &old.mode);
                        active_binding = Some(new_idx);
                        let binding = &cfg.bindings[new_idx];
                        spawn_hotkey_pressed(
                            app_handle,
                            &binding.mode,
                            binding.prompt_id.clone(),
                        );
                    }
                    // Binding deactivated (release)
                    (None, Some(old_idx)) => {
                        let old = &cfg.bindings[old_idx];
                        spawn_hotkey_released(app_handle, &old.mode);
                        active_binding = None;
                    }
                    _ => {}
                }
            }
            Err(keytap::RecvTimeoutError::Timeout) => continue,
            Err(keytap::RecvTimeoutError::Disconnected) => {
                log_hotkey!(debug, "Tap disconnected, listener thread exiting");
                break;
            }
        }
    }
}

/// Find the first binding whose keys are all currently held.
fn find_matching_binding(held: &HashSet<Key>, bindings: &[HotkeyBinding]) -> Option<usize> {
    bindings.iter().position(|b| b.keys.iter().all(|k| held.contains(k)))
}

/// Dispatch a hotkey pressed event to the async runtime.
fn spawn_hotkey_pressed(
    app_handle: &tauri::AppHandle,
    mode: &str,
    prompt_id: Option<String>,
) {
    let handle = app_handle.clone();
    let mode = mode.to_string();
    tauri::async_runtime::spawn(async move {
        crate::on_hotkey_pressed(handle, &mode, prompt_id).await;
    });
}

/// Dispatch a hotkey released event to the async runtime.
fn spawn_hotkey_released(app_handle: &tauri::AppHandle, mode: &str) {
    let handle = app_handle.clone();
    let mode = mode.to_string();
    tauri::async_runtime::spawn(async move {
        crate::on_hotkey_released(handle, &mode).await;
    });
}

// ---------------------------------------------------------------------------
// Configuration updates
// ---------------------------------------------------------------------------

/// Create a new `HotkeyConfig` with the given initial bindings.
pub fn create_config(bindings: Vec<HotkeyBinding>) -> HotkeyConfig {
    Arc::new(RwLock::new(HotkeyConfigInner {
        bindings,
        escape_enabled: false,
        tap_active: false,
    }))
}

/// Reload all hotkey bindings from config (hot reload).
///
/// Called when the user saves config — the tap keeps running, only the
/// binding patterns in shared state are updated.
pub fn reload_bindings(
    config: &HotkeyConfig,
    main_hotkey_str: &str,
    main_mode: &str,
    prompts: &[PromptItem],
) {
    let mut new_bindings = Vec::new();

    // Main hotkey
    if !main_hotkey_str.is_empty() {
        if let Some(keys) = parse_hotkey_string(main_hotkey_str) {
            new_bindings.push(HotkeyBinding {
                keys,
                mode: main_mode.to_string(),
                prompt_id: None,
            });
        } else {
            log_hotkey!(warn, "Failed to parse main hotkey: '{}'", main_hotkey_str);
        }
    }

    // Prompt hotkeys
    for prompt in prompts {
        if let Some(keys) = parse_prompt_hotkey_to_keys(&prompt.hotkey) {
            new_bindings.push(HotkeyBinding {
                keys,
                mode: prompt.hotkey_mode.clone(),
                prompt_id: Some(prompt.id.clone()),
            });
        } else if !prompt.hotkey.is_sequence() || !prompt.hotkey.as_sequence().unwrap().is_empty()
        {
            log_hotkey!(warn, "Prompt '{}' hotkey {:?} uses unsupported keycodes, skipping", prompt.title, prompt.hotkey);
        }
    }

    let mut cfg = config.write().unwrap();
    if cfg.bindings == new_bindings {
        return; // No change, skip re-registration and logging
    }

    log_hotkey!(debug, "Hotkey bindings changed, loading {} binding(s)", new_bindings.len());
    cfg.bindings = new_bindings;
}

/// Toggle escape-key cancellation on or off.
pub fn set_escape_enabled(config: &HotkeyConfig, enabled: bool) {
    let mut cfg = config.write().unwrap();
    cfg.escape_enabled = enabled;
}

/// Build initial bindings from the current config and prompts.
pub fn build_initial_bindings(
    main_hotkey_str: &str,
    main_mode: &str,
    prompts: &[PromptItem],
) -> Vec<HotkeyBinding> {
    let mut bindings = Vec::new();

    if !main_hotkey_str.is_empty() {
        if let Some(keys) = parse_hotkey_string(main_hotkey_str) {
            bindings.push(HotkeyBinding {
                keys,
                mode: main_mode.to_string(),
                prompt_id: None,
            });
        }
    }

    for prompt in prompts {
        if let Some(keys) = parse_prompt_hotkey_to_keys(&prompt.hotkey) {
            bindings.push(HotkeyBinding {
                keys,
                mode: prompt.hotkey_mode.clone(),
                prompt_id: Some(prompt.id.clone()),
            });
        }
    }

    bindings
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::PromptItem;
    use keytap::Key;
    use std::collections::{BTreeSet, HashSet};

    // ── parse_hotkey_string tests ──────────────────────────────────────────

    #[test]
    fn parse_empty_string() {
        assert_eq!(parse_hotkey_string(""), None);
        assert_eq!(parse_hotkey_string("   "), None);
    }

    #[test]
    fn parse_single_function_key() {
        let keys = parse_hotkey_string("F13").unwrap();
        assert_eq!(keys, BTreeSet::from([Key::F13]));
    }

    #[test]
    fn parse_single_letter() {
        let keys = parse_hotkey_string("A").unwrap();
        assert_eq!(keys, BTreeSet::from([Key::A]));
    }

    #[test]
    fn parse_letter_f_as_key_not_function() {
        let keys = parse_hotkey_string("F").unwrap();
        assert_eq!(keys, BTreeSet::from([Key::F]));
    }

    #[test]
    fn parse_modifier_plus_letter_f() {
        let keys = parse_hotkey_string("Control+F").unwrap();
        assert_eq!(keys, BTreeSet::from([Key::ControlLeft, Key::F]));
    }

    #[test]
    fn parse_single_digit() {
        let keys = parse_hotkey_string("5").unwrap();
        assert_eq!(keys, BTreeSet::from([Key::Digit5]));
    }

    #[test]
    fn parse_modifier_plus_key() {
        let keys = parse_hotkey_string("Control+Shift+A").unwrap();
        assert_eq!(
            keys,
            BTreeSet::from([Key::ControlLeft, Key::ShiftLeft, Key::A])
        );
    }

    #[test]
    fn parse_spaces_around_plus() {
        let keys = parse_hotkey_string("Control + Shift + A").unwrap();
        assert_eq!(
            keys,
            BTreeSet::from([Key::ControlLeft, Key::ShiftLeft, Key::A])
        );
    }

    #[test]
    fn parse_ctrl_alias() {
        let keys = parse_hotkey_string("Ctrl+C").unwrap();
        assert_eq!(keys, BTreeSet::from([Key::ControlLeft, Key::C]));
    }

    #[test]
    fn parse_alt_option_alias() {
        let keys = parse_hotkey_string("Option+X").unwrap();
        assert_eq!(keys, BTreeSet::from([Key::AltLeft, Key::X]));
    }

    #[test]
    fn parse_super_cmd_alias() {
        let keys = parse_hotkey_string("Cmd+V").unwrap();
        assert_eq!(keys, BTreeSet::from([Key::MetaLeft, Key::V]));
    }

    #[test]
    fn parse_side_specific_modifiers() {
        let keys = parse_hotkey_string("ShiftRight+ControlLeft+F").unwrap();
        assert_eq!(
            keys,
            BTreeSet::from([Key::ShiftRight, Key::ControlLeft, Key::F])
        );
    }

    #[test]
    fn parse_left_modifier_variants() {
        let tests = vec![
            ("ControlLeft+T", BTreeSet::from([Key::ControlLeft, Key::T])),
            ("CtrlLeft+T", BTreeSet::from([Key::ControlLeft, Key::T])),
            ("LeftCtrl+T", BTreeSet::from([Key::ControlLeft, Key::T])),
            ("LeftControl+T", BTreeSet::from([Key::ControlLeft, Key::T])),
            ("ShiftLeft+T", BTreeSet::from([Key::ShiftLeft, Key::T])),
            ("LeftShift+T", BTreeSet::from([Key::ShiftLeft, Key::T])),
            ("AltLeft+T", BTreeSet::from([Key::AltLeft, Key::T])),
            ("MetaLeft+T", BTreeSet::from([Key::MetaLeft, Key::T])),
            ("CmdLeft+T", BTreeSet::from([Key::MetaLeft, Key::T])),
            ("CommandLeft+T", BTreeSet::from([Key::MetaLeft, Key::T])),
        ];
        for (input, expected) in tests {
            assert_eq!(
                parse_hotkey_string(input),
                Some(expected),
                "failed for input: {}",
                input
            );
        }
    }

    #[test]
    fn parse_right_modifier_variants() {
        let tests = vec![
            (
                "ControlRight+T",
                BTreeSet::from([Key::ControlRight, Key::T]),
            ),
            (
                "ShiftRight+T",
                BTreeSet::from([Key::ShiftRight, Key::T]),
            ),
            (
                "AltRight+T",
                BTreeSet::from([Key::AltRight, Key::T]),
            ),
            (
                "MetaRight+T",
                BTreeSet::from([Key::MetaRight, Key::T]),
            ),
        ];
        for (input, expected) in tests {
            assert_eq!(
                parse_hotkey_string(input),
                Some(expected),
                "failed for input: {}",
                input
            );
        }
    }

    #[test]
    fn parse_special_keys() {
        let tests = vec![
            ("Space", Key::Space),
            ("Enter", Key::Enter),
            ("Return", Key::Enter),
            ("Tab", Key::Tab),
            ("Escape", Key::Escape),
            ("Esc", Key::Escape),
            ("Backspace", Key::Backspace),
            ("Up", Key::ArrowUp),
            ("ArrowUp", Key::ArrowUp),
            ("Down", Key::ArrowDown),
            ("Left", Key::ArrowLeft),
            ("Right", Key::ArrowRight),
            ("Home", Key::Home),
            ("End", Key::End),
            ("PageUp", Key::PageUp),
            ("PageDown", Key::PageDown),
            ("Insert", Key::Insert),
            ("Delete", Key::Delete),
            ("CapsLock", Key::CapsLock),
        ];
        for (input, expected) in tests {
            assert_eq!(
                parse_hotkey_string(input),
                Some(BTreeSet::from([expected])),
                "failed for input: {}",
                input
            );
        }
    }

    #[test]
    fn parse_symbolic_keys() {
        let tests = vec![
            ("Backtick", Key::Backtick),
            ("Grave", Key::Backtick),
            ("Minus", Key::Minus),
            ("Equal", Key::Equal),
            ("Equals", Key::Equal),
            ("[", Key::BracketLeft),
            ("]", Key::BracketRight),
            ("\\", Key::Backslash),
            (";", Key::Semicolon),
            ("'", Key::Quote),
            (",", Key::Comma),
            (".", Key::Period),
            ("/", Key::Slash),
        ];
        for (input, expected) in tests {
            assert_eq!(
                parse_hotkey_string(input),
                Some(BTreeSet::from([expected])),
                "failed for input: {}",
                input
            );
        }
    }

    #[test]
    fn parse_function_keys_f1_to_f24() {
        for n in 1..=24 {
            let input = format!("F{}", n);
            let result = parse_hotkey_string(&input);
            assert!(result.is_some(), "F{} should parse", n);
            assert_eq!(result.unwrap().len(), 1);
        }
    }

    #[test]
    fn parse_f25_returns_none() {
        assert_eq!(parse_hotkey_string("F25"), None);
    }

    #[test]
    fn parse_unknown_token_returns_none() {
        assert_eq!(parse_hotkey_string("UnknownKey"), None);
    }

    #[test]
    fn parse_lowercase_letter() {
        let keys = parse_hotkey_string("a").unwrap();
        assert_eq!(keys, BTreeSet::from([Key::A]));
    }

    #[test]
    fn parse_mixed_case_modifier() {
        let keys = parse_hotkey_string("SHIFT+A").unwrap();
        assert_eq!(keys, BTreeSet::from([Key::ShiftLeft, Key::A]));
    }

    // ── parse_prompt_hotkey_to_keys tests ──────────────────────────────────

    fn make_str_seq(items: &[&str]) -> serde_norway::Value {
        serde_norway::Value::Sequence(
            items
                .iter()
                .map(|s| serde_norway::Value::String(s.to_string()))
                .collect(),
        )
    }

    fn make_num_seq(nums: &[u64]) -> serde_norway::Value {
        serde_norway::Value::Sequence(
            nums.iter()
                .map(|n| serde_norway::Value::Number(serde_norway::Number::from(*n)))
                .collect(),
        )
    }

    #[test]
    fn parse_prompt_hotkey_string_format() {
        let hotkey = make_str_seq(&["Control+Shift+A"]);
        let keys = parse_prompt_hotkey_to_keys(&hotkey).unwrap();
        assert_eq!(
            keys,
            BTreeSet::from([Key::ControlLeft, Key::ShiftLeft, Key::A])
        );
    }

    #[test]
    fn parse_prompt_hotkey_keycode_format() {
        let hotkey = make_num_seq(&[29, 46, 4]);
        let keys = parse_prompt_hotkey_to_keys(&hotkey).unwrap();
        assert_eq!(
            keys,
            BTreeSet::from([Key::ControlLeft, Key::ShiftLeft, Key::A])
        );
    }

    #[test]
    fn parse_prompt_hotkey_empty_sequence() {
        let hotkey = serde_norway::Value::Sequence(vec![]);
        assert_eq!(parse_prompt_hotkey_to_keys(&hotkey), None);
    }

    #[test]
    fn parse_prompt_hotkey_null_returns_none() {
        assert_eq!(
            parse_prompt_hotkey_to_keys(&serde_norway::Value::Null),
            None
        );
    }

    // ── keycode_to_key tests ──────────────────────────────────────────────

    #[test]
    fn keycode_modifiers() {
        assert_eq!(keycode_to_key(0x001D), Some(Key::ControlLeft));
        assert_eq!(keycode_to_key(0x009D), Some(Key::ControlLeft));
        assert_eq!(keycode_to_key(0x002E), Some(Key::ShiftLeft));
        assert_eq!(keycode_to_key(0x0036), Some(Key::ShiftRight));
        assert_eq!(keycode_to_key(0x0038), Some(Key::AltLeft));
        assert_eq!(keycode_to_key(0x0138), Some(Key::AltRight));
        assert_eq!(keycode_to_key(0x0037), Some(Key::MetaLeft));
    }

    #[test]
    fn keycode_special() {
        assert_eq!(keycode_to_key(0x0020), Some(Key::Space));
        assert_eq!(keycode_to_key(0x0028), Some(Key::Enter));
        assert_eq!(keycode_to_key(0x002A), Some(Key::Backspace));
        assert_eq!(keycode_to_key(0x002B), Some(Key::Tab));
        assert_eq!(keycode_to_key(0x0001), Some(Key::Escape));
    }

    #[test]
    fn keycode_function_keys() {
        assert_eq!(keycode_to_key(0x003B), Some(Key::F1));
        assert_eq!(keycode_to_key(0x0044), Some(Key::F10));
        assert_eq!(keycode_to_key(0x0057), Some(Key::F11));
        assert_eq!(keycode_to_key(0x0058), Some(Key::F12));
    }

    #[test]
    fn keycode_letters() {
        assert_eq!(keycode_to_key(0x0004), Some(Key::A));
        assert_eq!(keycode_to_key(0x001E), Some(Key::Z));
        assert_eq!(keycode_to_key(0x000C), Some(Key::I));
    }

    #[test]
    fn keycode_digits() {
        assert_eq!(keycode_to_key(0x001F), Some(Key::Digit1));
        assert_eq!(keycode_to_key(0x002C), Some(Key::Digit0));
    }

    #[test]
    fn keycode_unknown_returns_none() {
        assert_eq!(keycode_to_key(0xFFFF), None);
        assert_eq!(keycode_to_key(0x0000), None);
    }

    // ── find_matching_binding tests ────────────────────────────────────────

    fn make_binding(keys: BTreeSet<Key>, mode: &str) -> HotkeyBinding {
        HotkeyBinding {
            keys,
            mode: mode.to_string(),
            prompt_id: None,
        }
    }

    #[test]
    fn find_first_matching_binding() {
        let binding_a = make_binding(BTreeSet::from([Key::ControlLeft, Key::A]), "toggle");
        let binding_b = make_binding(BTreeSet::from([Key::ControlLeft, Key::B]), "hold");
        let bindings = vec![binding_a.clone(), binding_b];

        let held: HashSet<Key> = [Key::ControlLeft, Key::A].into_iter().collect();
        assert_eq!(find_matching_binding(&held, &bindings), Some(0));

        let held: HashSet<Key> = [Key::ControlLeft, Key::B].into_iter().collect();
        assert_eq!(find_matching_binding(&held, &bindings), Some(1));
    }

    #[test]
    fn find_matching_requires_all_keys() {
        let binding = make_binding(
            BTreeSet::from([Key::ControlLeft, Key::ShiftLeft, Key::A]),
            "toggle",
        );
        let bindings = vec![binding];

        let held: HashSet<Key> = [Key::ControlLeft, Key::A].into_iter().collect();
        assert_eq!(find_matching_binding(&held, &bindings), None);

        let held: HashSet<Key> = [Key::ControlLeft, Key::ShiftLeft, Key::A].into_iter().collect();
        assert_eq!(find_matching_binding(&held, &bindings), Some(0));
    }

    #[test]
    fn find_matching_extra_keys_held_ok() {
        let binding = make_binding(BTreeSet::from([Key::ControlLeft, Key::A]), "toggle");
        let bindings = vec![binding];

        let held: HashSet<Key> = [Key::ControlLeft, Key::A, Key::ShiftLeft]
            .into_iter()
            .collect();
        assert_eq!(find_matching_binding(&held, &bindings), Some(0));
    }

    #[test]
    fn find_matching_empty_bindings() {
        let held: HashSet<Key> = [Key::ControlLeft, Key::A].into_iter().collect();
        assert_eq!(find_matching_binding(&held, &[]), None);
    }

    #[test]
    fn find_matching_empty_held() {
        let binding = make_binding(BTreeSet::from([Key::A]), "toggle");
        let bindings = vec![binding];
        let held = HashSet::new();
        assert_eq!(find_matching_binding(&held, &bindings), None);
    }

    // ── build_initial_bindings / reload_bindings tests ─────────────────────

    fn make_prompt_item(id: &str, hotkey: serde_norway::Value) -> PromptItem {
        PromptItem {
            id: id.to_string(),
            title: "Test".to_string(),
            hotkey,
            hotkey_mode: "hold".to_string(),
            prompt: "Be concise".to_string(),
        }
    }

    #[test]
    fn build_empty_when_main_hotkey_empty() {
        let bindings = build_initial_bindings("", "toggle", &[]);
        assert!(bindings.is_empty());
    }

    #[test]
    fn build_main_hotkey_only() {
        let bindings = build_initial_bindings("Control+Space", "toggle", &[]);
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].mode, "toggle");
        assert_eq!(bindings[0].prompt_id, None);
        assert_eq!(
            bindings[0].keys,
            BTreeSet::from([Key::ControlLeft, Key::Space])
        );
    }

    #[test]
    fn build_main_plus_prompts() {
        let prompt = make_prompt_item("p1", make_str_seq(&["Control+Shift+P"]));
        let bindings = build_initial_bindings("F13", "toggle", &[prompt]);
        assert_eq!(bindings.len(), 2);
        assert_eq!(bindings[0].prompt_id, None);
        assert_eq!(bindings[1].prompt_id, Some("p1".to_string()));
        assert_eq!(bindings[1].mode, "hold");
    }

    #[test]
    fn build_prompt_with_keycode_format() {
        let prompt = make_prompt_item("legacy", make_num_seq(&[29, 4]));
        let bindings = build_initial_bindings("", "toggle", &[prompt]);
        assert_eq!(bindings.len(), 1);
        assert_eq!(
            bindings[0].keys,
            BTreeSet::from([Key::ControlLeft, Key::A])
        );
    }

    #[test]
    fn build_skips_prompt_with_empty_hotkey() {
        let prompt = make_prompt_item("p1", serde_norway::Value::Sequence(vec![]));
        let bindings = build_initial_bindings("F13", "toggle", &[prompt]);
        assert_eq!(bindings.len(), 1);
    }

    #[test]
    fn build_skips_invalid_main_hotkey() {
        let bindings = build_initial_bindings("InvalidZZZ", "toggle", &[]);
        assert!(bindings.is_empty());
    }

    // ── create_config / set_escape_enabled tests ───────────────────────────

    #[test]
    fn test_create_config_defaults() {
        let config = create_config(vec![]);
        let cfg = config.read().unwrap();
        assert!(cfg.bindings.is_empty());
        assert!(!cfg.escape_enabled);
        assert!(!cfg.tap_active);
    }

    #[test]
    fn test_set_escape_enabled() {
        let config = create_config(vec![]);
        {
            let cfg = config.read().unwrap();
            assert!(!cfg.escape_enabled);
        }
        set_escape_enabled(&config, true);
        {
            let cfg = config.read().unwrap();
            assert!(cfg.escape_enabled);
        }
        set_escape_enabled(&config, false);
        {
            let cfg = config.read().unwrap();
            assert!(!cfg.escape_enabled);
        }
    }

    // ── reload_bindings tests ─────────────────────────────────────────────

    #[test]
    fn reload_updates_bindings() {
        let config = create_config(vec![]);
        {
            let cfg = config.read().unwrap();
            assert!(cfg.bindings.is_empty());
        }

        reload_bindings(&config, "Control+A", "hold", &[]);
        {
            let cfg = config.read().unwrap();
            assert_eq!(cfg.bindings.len(), 1);
            assert_eq!(cfg.bindings[0].mode, "hold");
        }
    }

    #[test]
    fn reload_noop_when_bindings_unchanged() {
        let binding = make_binding(BTreeSet::from([Key::ControlLeft, Key::A]), "toggle");
        let config = create_config(vec![binding.clone()]);

        let cfg_before = config.read().unwrap().bindings.clone();
        reload_bindings(&config, "Control+A", "toggle", &[]);
        let cfg_after = config.read().unwrap().bindings.clone();
        assert_eq!(cfg_before, cfg_after);
    }

    #[test]
    fn reload_with_prompts() {
        let config = create_config(vec![]);
        let prompt = make_prompt_item("p1", make_str_seq(&["Control+Shift+P"]));

        reload_bindings(&config, "F13", "toggle", &[prompt]);
        {
            let cfg = config.read().unwrap();
            assert_eq!(cfg.bindings.len(), 2);
            assert_eq!(cfg.bindings[1].prompt_id, Some("p1".to_string()));
        }
    }
}
