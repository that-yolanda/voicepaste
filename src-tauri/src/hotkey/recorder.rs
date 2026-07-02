//! Backend hotkey recording (UI recorder): capture a live key combination and
//! build its canonical config string.

#[cfg(not(target_os = "windows"))]
use keytap::EventKind;
use keytap::Key;
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

/// Record one hotkey combination from the live keyboard. Mirrors the frontend
/// DOM recorder's state machine so behaviour stays consistent:
///   - keydown accumulates into the pressed set;
///   - releasing a non-modifier finalizes "modifiers + that key";
///   - releasing a modifier when only modifiers are held starts a 300ms timer
///     that finalizes a modifier-only hotkey (e.g. `Fn`, `RightShift`);
///   - `Escape` cancels; elapsed `timeout` with no completion cancels.
///
/// Runs on a dedicated blocking thread; returns `None` on cancel/timeout, else
/// the config string (e.g. "ControlLeft+A").
///
/// # Platform differences
///
/// | Platform | Input source                           |
/// |----------|----------------------------------------|
/// | macOS    | relay channel from resident keytap tap |
/// | Linux    | relay channel from resident keytap tap |
/// | Windows  | `GetAsyncKeyState` polling             |
///
/// Windows uses polling because [`WH_KEYBOARD_LL`] hooks are blocked by
/// Chromium/WebView2 when a Tauri window has focus — the hook thread's message
/// pump is starved and the system never injects the hook callback.  Polling
/// reads the physical keyboard state directly from the kernel, bypassing the
/// message queue entirely.
pub(crate) fn record_combination(config: &HotkeyConfig, timeout: Duration) -> Option<String> {
    // Suppress the resident listener's hotkey matcher so normal hotkeys don't
    // fire while we're capturing a combination.
    {
        let mut cfg = config.write().unwrap();
        cfg.recording = true;
    }

    struct ClearGuard<'a> {
        config: &'a HotkeyConfig,
    }
    impl Drop for ClearGuard<'_> {
        fn drop(&mut self) {
            let mut cfg = self.config.write().unwrap();
            cfg.recording = false;
        }
    }
    let _guard = ClearGuard { config };

    #[cfg(target_os = "windows")]
    {
        windows_poll::record_via_polling(timeout)
    }

    #[cfg(not(target_os = "windows"))]
    {
        record_via_relay(config, timeout)
    }
}

// ── macOS / Linux: relay path ────────────────────────────────────────────────

#[cfg(not(target_os = "windows"))]
fn record_via_relay(config: &HotkeyConfig, timeout: Duration) -> Option<String> {
    let (tx, rx) = crossbeam_channel::bounded::<keytap::Event>(256);
    {
        let mut cfg = config.write().unwrap();
        cfg.record_tx = Some(tx);
    }

    struct RelayGuard<'a> {
        config: &'a HotkeyConfig,
    }
    impl Drop for RelayGuard<'_> {
        fn drop(&mut self) {
            let mut cfg = self.config.write().unwrap();
            cfg.record_tx = None;
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

// ── Windows: GetAsyncKeyState polling path ───────────────────────────────────

#[cfg(target_os = "windows")]
mod windows_poll {
    use super::*;
    use std::collections::BTreeSet;

    extern "system" {
        /// <https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getasynckeystate>
        fn GetAsyncKeyState(vKey: i32) -> i16;
    }

    // ── VK constants (per Logical Key, same values keytap's keycodes.rs uses) ─

    const VK_LSHIFT: i32 = 0xA0;
    const VK_RSHIFT: i32 = 0xA1;
    const VK_LCONTROL: i32 = 0xA2;
    const VK_RCONTROL: i32 = 0xA3;
    const VK_LMENU: i32 = 0xA4;
    const VK_RMENU: i32 = 0xA5;
    const VK_LWIN: i32 = 0x5B;
    const VK_RWIN: i32 = 0x5C;
    const VK_CAPITAL: i32 = 0x14;
    const VK_BACK: i32 = 0x08;
    const VK_TAB: i32 = 0x09;
    const VK_RETURN: i32 = 0x0D;
    const VK_ESCAPE: i32 = 0x1B;
    const VK_SPACE: i32 = 0x20;
    const VK_LEFT: i32 = 0x25;
    const VK_UP: i32 = 0x26;
    const VK_RIGHT: i32 = 0x27;
    const VK_DOWN: i32 = 0x28;
    const VK_HOME: i32 = 0x24;
    const VK_END: i32 = 0x23;
    const VK_PRIOR: i32 = 0x21;
    const VK_NEXT: i32 = 0x22;
    const VK_INSERT: i32 = 0x2D;
    const VK_DELETE: i32 = 0x2E;
    const VK_SNAPSHOT: i32 = 0x2C;
    const VK_SCROLL: i32 = 0x91;
    const VK_PAUSE: i32 = 0x13;
    const VK_NUMLOCK: i32 = 0x90;
    const VK_APPS: i32 = 0x5D;
    // OEM punctuation — US layout scan codes
    const VK_OEM_3: i32 = 0xC0; // Backtick / ~
    const VK_OEM_MINUS: i32 = 0xBD; // Minus / _
    const VK_OEM_PLUS: i32 = 0xBB; // Equal / +
    const VK_OEM_4: i32 = 0xDB; // BracketLeft / {
    const VK_OEM_6: i32 = 0xDD; // BracketRight / }
    const VK_OEM_5: i32 = 0xDC; // Backslash / |
    const VK_OEM_1: i32 = 0xBA; // Semicolon / :
    const VK_OEM_7: i32 = 0xDE; // Quote / "
    const VK_OEM_COMMA: i32 = 0xBC; // Comma / <
    const VK_OEM_PERIOD: i32 = 0xBE; // Period / >
    const VK_OEM_2: i32 = 0xBF; // Slash / ?
    const VK_OEM_102: i32 = 0xE2; // IntlBackslash (ISO)

    /// Bit mask for the "key is currently pressed" state.
    const KEY_DOWN_MASK: i16 = 0x8000u16 as i16;

    /// Returns the complete list of `(VK, Key)` pairs the recorder polls.
    fn pollable_keys() -> Vec<(i32, Key)> {
        let mut v = Vec::with_capacity(128);

        // Modifiers
        v.push((VK_LSHIFT, Key::ShiftLeft));
        v.push((VK_RSHIFT, Key::ShiftRight));
        v.push((VK_LCONTROL, Key::ControlLeft));
        v.push((VK_RCONTROL, Key::ControlRight));
        v.push((VK_LMENU, Key::AltLeft));
        v.push((VK_RMENU, Key::AltRight));
        v.push((VK_LWIN, Key::MetaLeft));
        v.push((VK_RWIN, Key::MetaRight));
        v.push((VK_CAPITAL, Key::CapsLock));

        // Special
        v.push((VK_BACK, Key::Backspace));
        v.push((VK_TAB, Key::Tab));
        v.push((VK_RETURN, Key::Enter));
        v.push((VK_ESCAPE, Key::Escape));
        v.push((VK_SPACE, Key::Space));

        // Arrows
        v.push((VK_LEFT, Key::ArrowLeft));
        v.push((VK_UP, Key::ArrowUp));
        v.push((VK_RIGHT, Key::ArrowRight));
        v.push((VK_DOWN, Key::ArrowDown));

        // Navigation
        v.push((VK_HOME, Key::Home));
        v.push((VK_END, Key::End));
        v.push((VK_PRIOR, Key::PageUp));
        v.push((VK_NEXT, Key::PageDown));
        v.push((VK_INSERT, Key::Insert));
        v.push((VK_DELETE, Key::Delete));

        // Misc
        v.push((VK_SNAPSHOT, Key::PrintScreen));
        v.push((VK_SCROLL, Key::ScrollLock));
        v.push((VK_PAUSE, Key::Pause));
        v.push((VK_NUMLOCK, Key::NumLock));
        v.push((VK_APPS, Key::Menu));

        // Function row F1–F24
        v.push((0x70, Key::F1));
        v.push((0x71, Key::F2));
        v.push((0x72, Key::F3));
        v.push((0x73, Key::F4));
        v.push((0x74, Key::F5));
        v.push((0x75, Key::F6));
        v.push((0x76, Key::F7));
        v.push((0x77, Key::F8));
        v.push((0x78, Key::F9));
        v.push((0x79, Key::F10));
        v.push((0x7A, Key::F11));
        v.push((0x7B, Key::F12));
        v.push((0x7C, Key::F13));
        v.push((0x7D, Key::F14));
        v.push((0x7E, Key::F15));
        v.push((0x7F, Key::F16));
        v.push((0x80, Key::F17));
        v.push((0x81, Key::F18));
        v.push((0x82, Key::F19));
        v.push((0x83, Key::F20));
        v.push((0x84, Key::F21));
        v.push((0x85, Key::F22));
        v.push((0x86, Key::F23));
        v.push((0x87, Key::F24));

        // Letters A–Z
        v.push((0x41, Key::A));
        v.push((0x42, Key::B));
        v.push((0x43, Key::C));
        v.push((0x44, Key::D));
        v.push((0x45, Key::E));
        v.push((0x46, Key::F));
        v.push((0x47, Key::G));
        v.push((0x48, Key::H));
        v.push((0x49, Key::I));
        v.push((0x4A, Key::J));
        v.push((0x4B, Key::K));
        v.push((0x4C, Key::L));
        v.push((0x4D, Key::M));
        v.push((0x4E, Key::N));
        v.push((0x4F, Key::O));
        v.push((0x50, Key::P));
        v.push((0x51, Key::Q));
        v.push((0x52, Key::R));
        v.push((0x53, Key::S));
        v.push((0x54, Key::T));
        v.push((0x55, Key::U));
        v.push((0x56, Key::V));
        v.push((0x57, Key::W));
        v.push((0x58, Key::X));
        v.push((0x59, Key::Y));
        v.push((0x5A, Key::Z));

        // Digits 0–9
        v.push((0x30, Key::Digit0));
        v.push((0x31, Key::Digit1));
        v.push((0x32, Key::Digit2));
        v.push((0x33, Key::Digit3));
        v.push((0x34, Key::Digit4));
        v.push((0x35, Key::Digit5));
        v.push((0x36, Key::Digit6));
        v.push((0x37, Key::Digit7));
        v.push((0x38, Key::Digit8));
        v.push((0x39, Key::Digit9));

        // OEM punctuation
        v.push((VK_OEM_3, Key::Backtick));
        v.push((VK_OEM_MINUS, Key::Minus));
        v.push((VK_OEM_PLUS, Key::Equal));
        v.push((VK_OEM_4, Key::BracketLeft));
        v.push((VK_OEM_6, Key::BracketRight));
        v.push((VK_OEM_5, Key::Backslash));
        v.push((VK_OEM_1, Key::Semicolon));
        v.push((VK_OEM_7, Key::Quote));
        v.push((VK_OEM_COMMA, Key::Comma));
        v.push((VK_OEM_PERIOD, Key::Period));
        v.push((VK_OEM_2, Key::Slash));
        v.push((VK_OEM_102, Key::IntlBackslash));

        v
    }

    /// Poll the physical keyboard state and return the set of keys that are
    /// currently held down.  Reads the hardware state directly — no message
    /// queue involvement, no UIPI, no WebView2 interference.
    fn snapshot() -> BTreeSet<Key> {
        let mut held = BTreeSet::new();
        for &(vk, key) in &pollable_keys() {
            let state = unsafe { GetAsyncKeyState(vk) };
            if (state & KEY_DOWN_MASK) != 0 {
                held.insert(key);
            }
        }
        held
    }

    /// An event produced by diffing two successive keyboard snapshots.
    #[derive(Debug, Clone, Copy)]
    enum PollEvent {
        Down(Key),
        Up(Key),
    }

    /// Compare two snapshots and return the events needed to transition from
    /// `prev` to `curr`.  Events are ordered: KeyDown first, then modifier
    /// KeyUp, then non-modifier KeyUp last — this prevents a non-modifier
    /// release from prematurely finalising before a simultaneous modifier
    /// release has been reflected in the pressed set.
    fn diff_events(prev: &BTreeSet<Key>, curr: &BTreeSet<Key>) -> Vec<PollEvent> {
        let mut events = Vec::new();

        // Keys newly pressed
        for &k in curr.iter() {
            if !prev.contains(&k) {
                events.push(PollEvent::Down(k));
            }
        }
        // Keys newly released
        for &k in prev.iter() {
            if !curr.contains(&k) {
                events.push(PollEvent::Up(k));
            }
        }

        // Stable sort: Down(0) < Up(modifier)(1) < Up(non-modifier)(2)
        events.sort_by_key(|e| match e {
            PollEvent::Down(_) => 0,
            PollEvent::Up(k) if is_modifier_key(*k) => 1,
            PollEvent::Up(_) => 2,
        });

        events
    }

    /// Run one recording session via `GetAsyncKeyState` polling.
    ///
    /// The polling interval is 10 ms (100 Hz).  Human key-press duration is
    /// ≥ 50 ms so every press/release straddles at least 5 samples — we never
    /// miss a transition.  An initial baseline snapshot prevents already-held
    /// keys from leaking into the recording.
    pub(super) fn record_via_polling(timeout: Duration) -> Option<String> {
        let mut pressed: BTreeSet<Key> = BTreeSet::new();
        let mut prev_snapshot = snapshot(); // baseline — ignore pre-held keys
        let start = Instant::now();
        let mut finalize_at: Option<Instant> = None;

        loop {
            if start.elapsed() >= timeout {
                return None;
            }

            std::thread::sleep(Duration::from_millis(10));

            let curr = snapshot();
            let events = diff_events(&prev_snapshot, &curr);
            prev_snapshot = curr;

            for event in events {
                match event {
                    PollEvent::Down(Key::Escape) => return None,
                    PollEvent::Down(k) => {
                        pressed.insert(k);
                        if !is_modifier_key(k) {
                            finalize_at = None;
                        }
                    }
                    PollEvent::Up(k) => {
                        // NOTE: do NOT remove from pressed — the set tracks the
                        // peak (all keys ever pressed during this recording),
                        // matching the hook-based recorder's behaviour.
                        if !is_modifier_key(k) {
                            if let Some(s) = build_hotkey_string(&pressed) {
                                return Some(s);
                            }
                        } else if !pressed.is_empty() && pressed.iter().all(|&k| is_modifier_key(k))
                        {
                            finalize_at = Some(Instant::now() + Duration::from_millis(300));
                        }
                    }
                }
            }

            if let Some(deadline) = finalize_at {
                if Instant::now() >= deadline {
                    finalize_at = None;
                    if !pressed.is_empty() && pressed.iter().all(|&k| is_modifier_key(k)) {
                        return build_hotkey_string(&pressed);
                    }
                }
            }
        }
    }

    // ── Tests for the Windows polling machinery ──────────────────────────

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn pollable_keys_covers_function_row() {
            let keys = pollable_keys();
            let f_keys: Vec<_> = keys
                .iter()
                .filter(|(vk, _)| *vk >= 0x70 && *vk <= 0x87)
                .collect();
            assert_eq!(f_keys.len(), 24, "F1–F24 should all be present");
        }

        #[test]
        fn pollable_keys_covers_letters() {
            let keys = pollable_keys();
            let letters: Vec<_> = keys
                .iter()
                .filter(|(vk, _)| *vk >= 0x41 && *vk <= 0x5A)
                .collect();
            assert_eq!(letters.len(), 26, "A–Z should all be present");
        }

        #[test]
        fn pollable_keys_covers_digits() {
            let keys = pollable_keys();
            let digits: Vec<_> = keys
                .iter()
                .filter(|(vk, _)| *vk >= 0x30 && *vk <= 0x39)
                .collect();
            assert_eq!(digits.len(), 10, "0–9 should all be present");
        }

        #[test]
        fn pollable_keys_correct_mapping_samples() {
            let keys = pollable_keys();
            // Spot-check a few VK→Key mappings.
            assert!(keys.contains(&(0xA2, Key::ControlLeft)));
            assert!(keys.contains(&(0xA3, Key::ControlRight)));
            assert!(keys.contains(&(0x70, Key::F1)));
            assert!(keys.contains(&(0x87, Key::F24)));
            assert!(keys.contains(&(0x41, Key::A)));
            assert!(keys.contains(&(0x5A, Key::Z)));
            assert!(keys.contains(&(0x30, Key::Digit0)));
            assert!(keys.contains(&(0x39, Key::Digit9)));
        }

        #[test]
        fn diff_empty_when_no_change() {
            let a: BTreeSet<Key> = [Key::ControlLeft, Key::A].into_iter().collect();
            let b = a.clone();
            assert!(diff_events(&a, &b).is_empty());
        }

        #[test]
        fn diff_detects_keydown() {
            let prev: BTreeSet<Key> = BTreeSet::new();
            let curr: BTreeSet<Key> = [Key::ControlLeft].into_iter().collect();
            let events = diff_events(&prev, &curr);
            assert_eq!(events.len(), 1);
            assert!(matches!(events[0], PollEvent::Down(Key::ControlLeft)));
        }

        #[test]
        fn diff_detects_keyup() {
            let prev: BTreeSet<Key> = [Key::ShiftLeft].into_iter().collect();
            let curr: BTreeSet<Key> = BTreeSet::new();
            let events = diff_events(&prev, &curr);
            assert_eq!(events.len(), 1);
            assert!(matches!(events[0], PollEvent::Up(Key::ShiftLeft)));
        }

        #[test]
        fn diff_orders_non_modifier_up_last() {
            // Ctrl+A released simultaneously → Up(Ctrl) must come before Up(A)
            // so the finaliser sees {Ctrl, A} not {A} (without modifier).
            let prev: BTreeSet<Key> = [Key::ControlLeft, Key::A].into_iter().collect();
            let curr: BTreeSet<Key> = BTreeSet::new();
            let events = diff_events(&prev, &curr);
            assert_eq!(events.len(), 2);
            // Up(ControlLeft) is a modifier — should sort first (1).
            assert!(matches!(events[0], PollEvent::Up(Key::ControlLeft)));
            // Up(A) is non-modifier — should sort last (2).
            assert!(matches!(events[1], PollEvent::Up(Key::A)));
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
