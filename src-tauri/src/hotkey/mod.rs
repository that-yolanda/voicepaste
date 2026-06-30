//! Global hotkey management via keytap.
//!
//! Replaces `tauri-plugin-global-shortcut` with a raw keyboard event stream
//! that supports modifier-only hotkeys and left/right modifier distinction.
//!
//! Submodules are private; the rest of the crate uses the re-exported API via
//! `crate::hotkey::*` (types, parse, listener, recorder, label).

mod label;
mod listener;
mod matcher;
mod parse;
mod recorder;

use std::collections::BTreeSet;
use std::sync::{Arc, RwLock};

use crossbeam_channel::Sender as CrossbeamSender;
use keytap::Key;

use crate::config::PromptItem;

// Re-export the public API so callers keep using `crate::hotkey::xxx`.
pub use label::current_hotkey_label;
pub use listener::{ensure_hotkey_active, reset_recording, start_hotkey_listener};
pub use matcher::MatcherState;
pub use parse::{parse_hotkey_string, parse_prompt_hotkey_to_keys};
pub(crate) use recorder::record_combination;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Hotkey activation mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HotkeyMode {
    /// Press once to start, press again to stop.
    Toggle,
    /// Hold to record, release to stop.
    Hold,
}

impl HotkeyMode {
    /// Parse from the config string form ("toggle" / "hold"). Unknown values
    /// default to `Toggle`.
    pub fn from_str(s: &str) -> Self {
        if s == "hold" {
            HotkeyMode::Hold
        } else {
            HotkeyMode::Toggle
        }
    }
}

/// A registered hotkey binding: a set of keys + metadata.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HotkeyBinding {
    /// The set of keys that must all be held simultaneously.
    pub keys: BTreeSet<Key>,
    /// Activation mode (toggle / hold).
    pub mode: HotkeyMode,
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
    /// resident listener forwards every event through `record_tx` instead of
    /// matching hotkey bindings, so a key press can't also fire the live
    /// hotkey during recording.
    pub recording: bool,
    /// Relay channel: set during hotkey-recording sessions. The resident
    /// listener sends every keyboard event here so the recorder can capture
    /// the combination without creating a second WH_KEYBOARD_LL hook (which
    /// is unreliable on Windows when two taps live in the same process).
    pub record_tx: Option<CrossbeamSender<keytap::Event>>,
    /// The hotkey state machine. Held under the same lock so lib.rs can reset
    /// it when a recording is cancelled or a start is diverted/failed.
    pub matcher: MatcherState,
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
// Configuration updates
// ---------------------------------------------------------------------------

/// Create a new `HotkeyConfig` with the given initial bindings.
pub fn create_config(bindings: Vec<HotkeyBinding>) -> HotkeyConfig {
    Arc::new(RwLock::new(HotkeyConfigInner {
        bindings,
        escape_enabled: false,
        tap_active: false,
        recording: false,
        record_tx: None,
        matcher: MatcherState::new(),
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
                mode: HotkeyMode::from_str(main_mode),
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
                mode: HotkeyMode::from_str(&prompt.hotkey_mode),
                prompt_id: Some(prompt.id.clone()),
            });
        } else if !prompt.hotkey.is_sequence() || !prompt.hotkey.as_sequence().unwrap().is_empty() {
            log_hotkey!(
                warn,
                "Prompt '{}' hotkey {:?} could not be parsed, skipping",
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
                mode: HotkeyMode::from_str(main_mode),
                prompt_id: None,
            });
        }
    }

    for prompt in prompts {
        if let Some(keys) = parse_prompt_hotkey_to_keys(&prompt.hotkey) {
            bindings.push(HotkeyBinding {
                keys,
                mode: HotkeyMode::from_str(&prompt.hotkey_mode),
                prompt_id: Some(prompt.id.clone()),
            });
        }
    }

    bindings
}

#[cfg(test)]
mod tests {
    use super::*;
    use keytap::Key;
    use std::collections::BTreeSet;

    fn make_str_seq(items: &[&str]) -> serde_norway::Value {
        serde_norway::Value::Sequence(
            items
                .iter()
                .map(|s| serde_norway::Value::String(s.to_string()))
                .collect(),
        )
    }

    fn make_binding(keys: BTreeSet<Key>, mode: &str) -> HotkeyBinding {
        HotkeyBinding {
            keys,
            mode: HotkeyMode::from_str(mode),
            prompt_id: None,
        }
    }

    fn make_prompt_item(id: &str, hotkey: serde_norway::Value) -> PromptItem {
        PromptItem {
            id: id.to_string(),
            title: "Test".to_string(),
            hotkey,
            hotkey_mode: "hold".to_string(),
            prompt: "Be concise".to_string(),
        }
    }

    // ── build_initial_bindings tests ──────────────────────────────────────

    #[test]
    fn build_empty_when_main_hotkey_empty() {
        let bindings = build_initial_bindings("", "toggle", &[]);
        assert!(bindings.is_empty());
    }

    #[test]
    fn build_main_hotkey_only() {
        let bindings = build_initial_bindings("Control+Space", "toggle", &[]);
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].mode, HotkeyMode::Toggle);
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
        assert_eq!(bindings[1].mode, HotkeyMode::Hold);
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

    // ── recording flag / record_tx relay tests ────────────────────────────

    #[test]
    fn record_tx_set_and_clear_in_config() {
        let config = create_config(vec![]);
        {
            let cfg = config.read().unwrap();
            assert!(!cfg.recording);
            assert!(cfg.record_tx.is_none());
        }
        // Simulate what record_combination does when starting a recording.
        let (tx, _rx) = crossbeam_channel::bounded::<keytap::Event>(1);
        {
            let mut cfg = config.write().unwrap();
            cfg.recording = true;
            cfg.record_tx = Some(tx);
            assert!(cfg.recording);
            assert!(cfg.record_tx.is_some());
        }
        // Simulate RelayGuard::drop clearing on return.
        {
            let mut cfg = config.write().unwrap();
            cfg.record_tx = None;
            cfg.recording = false;
        }
        let cfg = config.read().unwrap();
        assert!(!cfg.recording);
        assert!(cfg.record_tx.is_none());
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
            assert_eq!(cfg.bindings[0].mode, HotkeyMode::Hold);
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
