//! Global hotkey management via keytap.
//!
//! Replaces `tauri-plugin-global-shortcut` with a raw keyboard event stream
//! that supports modifier-only hotkeys and left/right modifier distinction.

use crate::config::PromptItem;
use keytap::{EventKind, Key, Tap};
use std::collections::{BTreeSet, HashSet};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

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
    /// `true` while the UI hotkey recorder is capturing a combination. The
    /// resident listener ignores every event (including Escape, which the
    /// recorder uses to cancel) so a key press can't also fire the live
    /// hotkey during recording.
    pub recording: bool,
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
        // macOS Fn / "Globe" (🌐) key. The CGEventTap reports keycode 63 as a
        // FlagsChanged event, which keytap maps to Key::Function. macOS often
        // hijacks this key for input-source / emoji / dictation — set "Press
        // 🌐 key to: Do Nothing" (System Settings → Keyboard) or no event
        // reaches the tap.
        "fn" | "function" | "globe" => Some(Key::Function),
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
        "intlbackslash" => Some(Key::IntlBackslash),
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
        0x002E => Some(Key::ShiftLeft),            // Left Shift
        0x0036 => Some(Key::ShiftRight),           // Right Shift
        0x0038 => Some(Key::AltLeft),              // Left Alt
        0x0138 => Some(Key::AltRight),             // Right Alt
        0x0037 | 0x00D7 => Some(Key::MetaLeft),    // Left/Right Meta → left for legacy compat
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
            log_hotkey!(
                warn,
                "Accessibility permission not granted — global hotkeys disabled"
            );
            return Ok(HotkeyManager { _config: config });
        }
        Err(e) => {
            log_hotkey!(
                error,
                "keytap init failed: {:?} — global hotkeys disabled",
                e
            );
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
                // While the UI recorder owns the keyboard, ignore every event
                // (including Escape — the recorder uses it to cancel) so a key
                // press can't also fire the live hotkey.
                if config.read().unwrap().recording {
                    continue;
                }
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

                if cfg.escape_enabled
                    && matches!(event_kind, EventKind::KeyDown(Key::Escape))
                    && !escape_was_pressed
                {
                    escape_was_pressed = true;
                    let handle = app_handle.clone();
                    tauri::async_runtime::spawn(async move {
                        crate::on_escape(handle).await;
                    });
                }

                // Match hotkey bindings
                let matched_idx = find_matching_binding(&held, &cfg.bindings);

                match (matched_idx, active_binding) {
                    // New binding activated (press)
                    (Some(new_idx), None) => {
                        active_binding = Some(new_idx);
                        let binding = &cfg.bindings[new_idx];
                        spawn_hotkey_pressed(app_handle, &binding.mode, binding.prompt_id.clone());
                    }
                    // Different binding activated (transition)
                    (Some(new_idx), Some(old_idx)) if new_idx != old_idx => {
                        let old = &cfg.bindings[old_idx];
                        spawn_hotkey_released(app_handle, &old.mode);
                        active_binding = Some(new_idx);
                        let binding = &cfg.bindings[new_idx];
                        spawn_hotkey_pressed(app_handle, &binding.mode, binding.prompt_id.clone());
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
    bindings
        .iter()
        .position(|b| b.keys.iter().all(|k| held.contains(k)))
}

/// Dispatch a hotkey pressed event to the async runtime.
fn spawn_hotkey_pressed(app_handle: &tauri::AppHandle, mode: &str, prompt_id: Option<String>) {
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
// Backend hotkey recording (UI recorder)
// ---------------------------------------------------------------------------

/// Whether a [`Key`] is a held-state modifier. Includes [`Key::Function`]
/// (the macOS Fn key surfaces as a FlagsChanged modifier) but excludes
/// [`Key::CapsLock`], matching the frontend recorder's classification so a
/// recorded Fn is treated as a modifier-only hotkey.
fn is_modifier_key(key: Key) -> bool {
    matches!(
        key,
        Key::ControlLeft
            | Key::ControlRight
            | Key::ShiftLeft
            | Key::ShiftRight
            | Key::AltLeft
            | Key::AltRight
            | Key::MetaLeft
            | Key::MetaRight
            | Key::Function
    )
}

/// Canonical modifier display order, matching the frontend recorder: Control,
/// then Alt, Shift, Meta, then Fn last. Yields a stable config string
/// regardless of press order.
fn modifier_rank(key: Key) -> u8 {
    match key {
        Key::ControlLeft => 0,
        Key::ControlRight => 1,
        Key::AltLeft => 2,
        Key::AltRight => 3,
        Key::ShiftLeft => 4,
        Key::ShiftRight => 5,
        Key::MetaLeft => 6,
        Key::MetaRight => 7,
        Key::Function => 8,
        _ => 9,
    }
}

/// Inverse of [`parse_single_key`]: map a recorded [`Key`] to the canonical
/// config token the parser accepts, so a recorded combination round-trips
/// through the config string. Returns `None` for keys with no parseable
/// spelling (numpad keys, raw unknown scancodes).
fn key_to_token(key: Key) -> Option<&'static str> {
    Some(match key {
        // Modifiers
        Key::ControlLeft => "ControlLeft",
        Key::ControlRight => "ControlRight",
        Key::ShiftLeft => "ShiftLeft",
        Key::ShiftRight => "ShiftRight",
        Key::AltLeft => "AltLeft",
        Key::AltRight => "AltRight",
        Key::MetaLeft => "MetaLeft",
        Key::MetaRight => "MetaRight",
        Key::Function => "Fn",
        Key::CapsLock => "CapsLock",
        // Special keys
        Key::Space => "Space",
        Key::Enter => "Enter",
        Key::Tab => "Tab",
        Key::Escape => "Escape",
        Key::Backspace => "Backspace",
        // Arrows
        Key::ArrowUp => "ArrowUp",
        Key::ArrowDown => "ArrowDown",
        Key::ArrowLeft => "ArrowLeft",
        Key::ArrowRight => "ArrowRight",
        // Navigation
        Key::Home => "Home",
        Key::End => "End",
        Key::PageUp => "PageUp",
        Key::PageDown => "PageDown",
        Key::Insert => "Insert",
        Key::Delete => "Delete",
        // Function row
        Key::F1 => "F1",
        Key::F2 => "F2",
        Key::F3 => "F3",
        Key::F4 => "F4",
        Key::F5 => "F5",
        Key::F6 => "F6",
        Key::F7 => "F7",
        Key::F8 => "F8",
        Key::F9 => "F9",
        Key::F10 => "F10",
        Key::F11 => "F11",
        Key::F12 => "F12",
        Key::F13 => "F13",
        Key::F14 => "F14",
        Key::F15 => "F15",
        Key::F16 => "F16",
        Key::F17 => "F17",
        Key::F18 => "F18",
        Key::F19 => "F19",
        Key::F20 => "F20",
        Key::F21 => "F21",
        Key::F22 => "F22",
        Key::F23 => "F23",
        Key::F24 => "F24",
        // Letters (single uppercase chars, as parse_single_key expects)
        Key::A => "A",
        Key::B => "B",
        Key::C => "C",
        Key::D => "D",
        Key::E => "E",
        Key::F => "F",
        Key::G => "G",
        Key::H => "H",
        Key::I => "I",
        Key::J => "J",
        Key::K => "K",
        Key::L => "L",
        Key::M => "M",
        Key::N => "N",
        Key::O => "O",
        Key::P => "P",
        Key::Q => "Q",
        Key::R => "R",
        Key::S => "S",
        Key::T => "T",
        Key::U => "U",
        Key::V => "V",
        Key::W => "W",
        Key::X => "X",
        Key::Y => "Y",
        Key::Z => "Z",
        // Digits (single-char tokens)
        Key::Digit0 => "0",
        Key::Digit1 => "1",
        Key::Digit2 => "2",
        Key::Digit3 => "3",
        Key::Digit4 => "4",
        Key::Digit5 => "5",
        Key::Digit6 => "6",
        Key::Digit7 => "7",
        Key::Digit8 => "8",
        Key::Digit9 => "9",
        // Punctuation
        Key::Backtick => "Backtick",
        Key::Minus => "Minus",
        Key::Equal => "Equal",
        Key::BracketLeft => "BracketLeft",
        Key::BracketRight => "BracketRight",
        Key::Backslash => "Backslash",
        Key::Semicolon => "Semicolon",
        Key::Quote => "Quote",
        Key::Comma => "Comma",
        Key::Period => "Period",
        Key::Slash => "Slash",
        Key::IntlBackslash => "IntlBackslash",
        // Misc
        Key::Menu => "Menu",
        Key::PrintScreen => "PrintScreen",
        Key::ScrollLock => "ScrollLock",
        Key::Pause => "Pause",
        Key::NumLock => "NumLock",
        // Numpad keys and Unknown scancodes have no parseable token
        _ => return None,
    })
}

/// Build the config string (e.g. "ControlLeft+A", "Fn") for a set of held
/// keys, mirroring the frontend recorder: modifiers in canonical order, then
/// the main key if any.
fn build_hotkey_string(pressed: &BTreeSet<Key>) -> Option<String> {
    let mut mods: Vec<Key> = Vec::new();
    let mut main_key: Option<Key> = None;
    for &k in pressed {
        if is_modifier_key(k) {
            mods.push(k);
        } else if main_key.is_none() {
            main_key = Some(k);
        }
    }
    mods.sort_by_key(|&k| modifier_rank(k));

    let mut parts: Vec<&str> = mods.iter().filter_map(|&k| key_to_token(k)).collect();
    if let Some(mk) = main_key {
        if let Some(tok) = key_to_token(mk) {
            parts.push(tok);
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("+"))
    }
}

/// Record one hotkey combination from the live keyboard via a temporary keytap
/// tap. Mirrors the frontend DOM recorder's state machine so behaviour stays
/// consistent:
///   - keydown accumulates into the pressed set;
///   - releasing a non-modifier finalizes "modifiers + that key";
///   - releasing a modifier when only modifiers are held starts a 300ms timer
///     that finalizes a modifier-only hotkey (e.g. `Fn`, `RightShift`);
///   - `Escape` cancels; elapsed `timeout` with no completion cancels.
///
/// Runs on a dedicated blocking thread; the tap is dropped (stopped) on
/// return. Returns `None` on cancel/timeout, else the config string.
/// RAII guard that sets `recording = true` on the shared hotkey config for
/// the duration of a recording session and resets it on drop — so even if
/// recording returns early (e.g. tap creation fails) or panics, the resident
/// listener always resumes.
struct RecordingGuard<'a> {
    config: &'a HotkeyConfig,
}

impl<'a> RecordingGuard<'a> {
    fn new(config: &'a HotkeyConfig) -> Self {
        config.write().unwrap().recording = true;
        Self { config }
    }
}

impl Drop for RecordingGuard<'_> {
    fn drop(&mut self) {
        self.config.write().unwrap().recording = false;
    }
}

pub(crate) fn record_combination(config: &HotkeyConfig, timeout: Duration) -> Option<String> {
    let _guard = RecordingGuard::new(config);
    let tap = Tap::new().ok()?;
    let mut pressed: BTreeSet<Key> = BTreeSet::new();
    let start = Instant::now();
    let mut finalize_at: Option<Instant> = None;

    loop {
        if start.elapsed() >= timeout {
            return None;
        }
        if let Some(deadline) = finalize_at {
            if Instant::now() >= deadline {
                finalize_at = None;
                if !pressed.is_empty() && pressed.iter().all(|&k| is_modifier_key(k)) {
                    return build_hotkey_string(&pressed);
                }
            }
        }

        match tap.recv_timeout(Duration::from_millis(50)) {
            Ok(event) => match event.kind {
                EventKind::KeyDown(Key::Escape) => return None,
                EventKind::KeyDown(k) => {
                    pressed.insert(k);
                    // A main key arrived — drop any modifier-only timer;
                    // finalize happens on its keyup (frontend parity).
                    if !is_modifier_key(k) {
                        finalize_at = None;
                    }
                }
                EventKind::KeyUp(k) => {
                    if !is_modifier_key(k) {
                        if let Some(s) = build_hotkey_string(&pressed) {
                            return Some(s);
                        }
                    } else if !pressed.is_empty() && pressed.iter().all(|&k| is_modifier_key(k)) {
                        finalize_at = Some(Instant::now() + Duration::from_millis(300));
                    }
                }
                EventKind::KeyRepeat(_) => {}
            },
            Err(keytap::RecvTimeoutError::Timeout) => continue,
            // Tap channel closed (listener stopped) — return instead of
            // busy-looping recv_timeout on a disconnected channel.
            Err(keytap::RecvTimeoutError::Disconnected) => return None,
        }
    }
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
        recording: false,
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
        } else if !prompt.hotkey.is_sequence() || !prompt.hotkey.as_sequence().unwrap().is_empty() {
            log_hotkey!(
                warn,
                "Prompt '{}' hotkey {:?} uses unsupported keycodes, skipping",
                prompt.title,
                prompt.hotkey
            );
        }
    }

    let mut cfg = config.write().unwrap();
    if cfg.bindings == new_bindings {
        return; // No change, skip re-registration and logging
    }

    log_hotkey!(
        debug,
        "Hotkey bindings changed, loading {} binding(s)",
        new_bindings.len()
    );
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
    fn parse_fn_token_maps_to_function() {
        // Every accepted spelling of the macOS Fn / Globe key must map to
        // Key::Function — before this branch existed, "Fn" fell through to
        // `_ => None` and the main hotkey was never registered.
        for tok in ["Fn", "fn", "Function", "FUNCTION", "Globe", "globe"] {
            let keys = parse_hotkey_string(tok)
                .unwrap_or_else(|| panic!("'{tok}' should parse to Key::Function"));
            assert_eq!(keys, BTreeSet::from([Key::Function]), "failed for '{tok}'");
        }
    }

    #[test]
    fn parse_fn_does_not_collide_with_letter_f_or_function_row() {
        // "F" → letter F, "Fn" → Fn key, "F1" → function-row key. The three
        // must stay distinct despite all starting with 'f'.
        assert_eq!(parse_hotkey_string("F").unwrap(), BTreeSet::from([Key::F]));
        assert_eq!(
            parse_hotkey_string("Fn").unwrap(),
            BTreeSet::from([Key::Function])
        );
        assert_eq!(
            parse_hotkey_string("F1").unwrap(),
            BTreeSet::from([Key::F1])
        );
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
            ("ShiftRight+T", BTreeSet::from([Key::ShiftRight, Key::T])),
            ("AltRight+T", BTreeSet::from([Key::AltRight, Key::T])),
            ("MetaRight+T", BTreeSet::from([Key::MetaRight, Key::T])),
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

    // ── key_to_token / build_hotkey_string tests ──────────────────────────

    #[test]
    fn key_to_token_round_trips_through_parser() {
        // Every token key_to_token emits must parse back to the same Key —
        // otherwise the recorder would write config strings it can't read.
        let cases = [
            Key::ControlLeft,
            Key::ControlRight,
            Key::ShiftLeft,
            Key::ShiftRight,
            Key::AltLeft,
            Key::AltRight,
            Key::MetaLeft,
            Key::MetaRight,
            Key::Function,
            Key::CapsLock,
            Key::Space,
            Key::Enter,
            Key::Escape,
            Key::Backspace,
            Key::ArrowUp,
            Key::ArrowDown,
            Key::Home,
            Key::PageDown,
            Key::F1,
            Key::F13,
            Key::F24,
            Key::A,
            Key::Z,
            Key::Digit0,
            Key::Digit9,
            Key::Minus,
            Key::Slash,
            Key::IntlBackslash,
            Key::NumLock,
        ];
        for k in cases {
            let tok = key_to_token(k).unwrap_or_else(|| panic!("{k:?} has no token"));
            let parsed =
                parse_hotkey_string(tok).unwrap_or_else(|| panic!("token '{tok}' did not parse"));
            assert_eq!(
                parsed,
                BTreeSet::from([k]),
                "round-trip failed for {k:?} -> '{tok}'"
            );
        }
    }

    #[test]
    fn key_to_token_returns_none_for_unparsable() {
        assert_eq!(key_to_token(Key::Unknown(keytap::RawCode(42))), None);
        assert_eq!(key_to_token(Key::Numpad0), None);
    }

    #[test]
    fn is_modifier_key_classification() {
        assert!(is_modifier_key(Key::Function));
        assert!(is_modifier_key(Key::ControlLeft));
        assert!(is_modifier_key(Key::MetaRight));
        // CapsLock is NOT treated as a held modifier here (frontend parity).
        assert!(!is_modifier_key(Key::CapsLock));
        assert!(!is_modifier_key(Key::A));
        assert!(!is_modifier_key(Key::Space));
    }

    #[test]
    fn build_hotkey_string_sorts_modifiers_then_main_key() {
        // Press order is A, Shift, Control — output must be canonical order.
        let pressed = BTreeSet::from([Key::A, Key::ShiftLeft, Key::ControlLeft]);
        assert_eq!(
            build_hotkey_string(&pressed).as_deref(),
            Some("ControlLeft+ShiftLeft+A")
        );
    }

    #[test]
    fn build_hotkey_string_modifier_only_fn() {
        let pressed = BTreeSet::from([Key::Function]);
        assert_eq!(build_hotkey_string(&pressed).as_deref(), Some("Fn"));
    }

    #[test]
    fn build_hotkey_string_single_main_key() {
        let pressed = BTreeSet::from([Key::F13]);
        assert_eq!(build_hotkey_string(&pressed).as_deref(), Some("F13"));
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

        let held: HashSet<Key> = [Key::ControlLeft, Key::ShiftLeft, Key::A]
            .into_iter()
            .collect();
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
        assert_eq!(bindings[0].keys, BTreeSet::from([Key::ControlLeft, Key::A]));
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
        assert!(!cfg.recording);
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

    // ── recording flag / RecordingGuard tests ─────────────────────────────

    #[test]
    fn recording_guard_sets_and_clears_flag() {
        let config = create_config(vec![]);
        assert!(!config.read().unwrap().recording);
        {
            let _guard = RecordingGuard::new(&config);
            assert!(config.read().unwrap().recording);
        }
        assert!(!config.read().unwrap().recording);
    }

    #[test]
    fn recording_guard_clears_flag_on_early_return() {
        // Mirrors record_combination's `Tap::new().ok()?` early return: the
        // guard must still reset the flag even when recording bails out.
        fn fail_to_record(config: &HotkeyConfig) -> Option<String> {
            let _guard = RecordingGuard::new(config);
            None // simulate the tap failing to create
        }
        let config = create_config(vec![]);
        assert_eq!(fail_to_record(&config), None);
        assert!(!config.read().unwrap().recording);
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
