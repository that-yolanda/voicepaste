//! Hotkey string parsing: config strings and prompt hotkey YAML values →
//! keytap `Key` sets.

use keytap::Key;
use std::collections::BTreeSet;

/// Parse a hotkey config string (e.g. "Control+Space", "F13", "RightShift")
/// into a set of keytap `Key`s.
///
/// Backward compatible: bare modifier names default to the left variant.
/// New syntax: "ControlLeft", "ShiftRight", etc. for side-specific keys.
pub fn parse_hotkey_string(s: &str) -> Option<BTreeSet<Key>> {
    let parts: Vec<&str> = s.split('+').map(|p| p.trim()).collect();
    if parts.iter().all(|p| p.is_empty()) {
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

/// Parse a prompt hotkey YAML value, stored as a string array like
/// `["Control+Shift+A"]`. Returns the parsed key set, or `None` when the value
/// is absent, empty, or not a string array.
///
/// The v1.x (Electron) format stored evdev/uIOhook keycode arrays
/// (`[29, 54, 4]`). Those are converted to accelerator strings once, at upgrade
/// time, by `migration::migrate_prompts` — runtime parsing intentionally does
/// not understand the legacy numeric form, so this module holds no keycode
/// tables and cannot misinterpret them.
pub fn parse_prompt_hotkey_to_keys(hotkey: &serde_norway::Value) -> Option<BTreeSet<Key>> {
    let seq = hotkey.as_sequence()?;
    parse_hotkey_string(seq.first()?.as_str()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use keytap::Key;
    use std::collections::BTreeSet;

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
}
