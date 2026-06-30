//! Backend hotkey recording (UI recorder): capture a live key combination and
//! build its canonical config string.

use keytap::{EventKind, Key};
use std::collections::BTreeSet;
use std::time::{Duration, Instant};

use super::HotkeyConfig;

/// Canonical modifier order, matching the frontend recorder: Control, then
/// Alt, Shift, Meta, then Fn last. Also defines the set of held-state modifiers
/// (used by [`is_modifier_key`]) — excludes `CapsLock` for frontend parity.
/// Centralized so the order list and the membership test can't drift apart.
const MODIFIER_ORDER: &[Key] = &[
    Key::ControlLeft,
    Key::ControlRight,
    Key::AltLeft,
    Key::AltRight,
    Key::ShiftLeft,
    Key::ShiftRight,
    Key::MetaLeft,
    Key::MetaRight,
    Key::Function,
];

/// Whether a [`Key`] is a held-state modifier. Includes [`Key::Function`]
/// (the macOS Fn key surfaces as a FlagsChanged modifier) but excludes
/// [`Key::CapsLock`], matching the frontend recorder's classification so a
/// recorded Fn is treated as a modifier-only hotkey.
fn is_modifier_key(key: Key) -> bool {
    MODIFIER_ORDER.contains(&key)
}

/// Canonical modifier display/sort rank from [`MODIFIER_ORDER`]. Non-modifiers
/// get `u8::MAX` (sort last), but this is only ever called on keys that pass
/// [`is_modifier_key`].
fn modifier_rank(key: Key) -> u8 {
    MODIFIER_ORDER
        .iter()
        .position(|&k| k == key)
        .map(|i| i as u8)
        .unwrap_or(u8::MAX)
}

/// Inverse of [`super::parse::parse_single_key`]: map a recorded [`Key`] to the
/// canonical config token the parser accepts, so a recorded combination
/// round-trips through the config string. Returns `None` for keys with no
/// parseable spelling (numpad keys, raw unknown scancodes).
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
pub(crate) fn record_combination(config: &HotkeyConfig, timeout: Duration) -> Option<String> {
    // Create a relay channel and register it in shared config so the resident
    // listener forwards every keyboard event here instead of matching bindings.
    // This avoids creating a second WH_KEYBOARD_LL hook, which is unreliable on
    // Windows when two taps live in the same process.
    let (tx, rx) = crossbeam_channel::bounded::<keytap::Event>(256);
    {
        let mut cfg = config.write().unwrap();
        cfg.record_tx = Some(tx);
        cfg.recording = true;
    }

    // RAII cleanup: clear the relay channel and recording flags on return so
    // the resident listener resumes normal hotkey matching.
    struct RelayGuard<'a> {
        config: &'a HotkeyConfig,
    }
    impl Drop for RelayGuard<'_> {
        fn drop(&mut self) {
            let mut cfg = self.config.write().unwrap();
            cfg.record_tx = None;
            cfg.recording = false;
        }
    }
    let _guard = RelayGuard { config };

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

        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(event) => match event.kind {
                EventKind::KeyDown(Key::Escape) => return None,
                EventKind::KeyDown(k) => {
                    pressed.insert(k);
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
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => continue,
            Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                log_hotkey!(
                    warn,
                    "record_combination: relay disconnected, returning None"
                );
                return None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use keytap::Key;
    use std::collections::BTreeSet;

    // parse_hotkey_string lives in the sibling `parse` module; re-import for
    // the round-trip test so we don't reach across via fragile paths.
    use super::super::parse::parse_hotkey_string;

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
}
