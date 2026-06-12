use crate::config::PromptItem;
use crate::hotkey::*;
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
    // "Shift" should parse regardless of case (to_lowercase is used)
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
    // Ctrl(0x001D=29) + Shift(0x002E=46) + A(0x0004=4)
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
    assert_eq!(keycode_to_key(0x009D), Some(Key::ControlLeft)); // Right → left
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

    // Extra keys held — still matches (all required keys are down)
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
    assert_eq!(bindings[0].prompt_id, None); // main
    assert_eq!(bindings[1].prompt_id, Some("p1".to_string()));
    assert_eq!(bindings[1].mode, "hold");
}

#[test]
fn build_prompt_with_keycode_format() {
    let prompt = make_prompt_item("legacy", make_num_seq(&[29, 4])); // Ctrl+A
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
    assert_eq!(bindings.len(), 1); // only main
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
    // Same hotkey and mode in reload
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
