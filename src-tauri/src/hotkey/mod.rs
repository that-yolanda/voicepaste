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
mod physical;
mod recorder;
mod validation;
pub use validation::{compile_bindings, validate_change, validate_target};

use std::collections::BTreeSet;
use std::sync::{Arc, RwLock};

use crossbeam_channel::Sender as CrossbeamSender;
use keytap::Key;
use tauri::{AppHandle, Manager};

// Re-export the public API so callers keep using `crate::hotkey::xxx`.
pub use label::{current_hotkey_label, format_hotkey_label};
pub use listener::{ensure_hotkey_active, reset_recording};
pub use matcher::MatcherState;
pub use parse::parse_hotkey_string;
pub(crate) use recorder::{is_valid_main_first_key, record_combination};

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
    /// Global wake binding: starts toggle sessions, never stops them.
    pub wake_only: bool,
}

/// Shared hotkey configuration, updatable without restarting the tap.
#[derive(Debug)]
pub struct HotkeyConfigInner {
    /// All registered bindings (main + prompts).
    pub bindings: Vec<HotkeyBinding>,
    /// Whether escape-key cancellation is currently enabled.
    pub escape_enabled: bool,
    /// Whether the Enter key is currently being watched to confirm "paste the
    /// raw text". Only enabled during the polish decision window and while a
    /// polish retry is in flight — Enter is an ordinary typing key otherwise.
    pub enter_enabled: bool,
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
fn create_config(bindings: Vec<HotkeyBinding>) -> HotkeyConfig {
    Arc::new(RwLock::new(HotkeyConfigInner {
        bindings,
        escape_enabled: false,
        enter_enabled: false,
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
pub fn reload_bindings(config: &HotkeyConfig, bindings: Vec<HotkeyBinding>) {
    let mut cfg = config.write().unwrap();
    if cfg.bindings != bindings {
        cfg.matcher.cancel_pending();
        cfg.bindings = bindings;
    }
}

/// Reload all hotkey bindings from the current config and prompts.
/// Called after saving config or prompts so changes take effect immediately.
pub fn reload_hotkey_bindings(app: &AppHandle) {
    use crate::app_state::AppInner;

    let Some(hc) = app.try_state::<HotkeyConfig>() else {
        log_hotkey!(error, "HotkeyConfig not in managed state");
        return;
    };

    let app_inner = app.state::<Arc<AppInner>>();
    let config = match app_inner.config_manager.load_config() {
        Ok(c) => c,
        Err(e) => {
            log_hotkey!(error, "Failed to load config for reload: {}", e);
            return;
        }
    };

    let prompts = app_inner.config_manager.load_prompts();
    let (bindings, _) = compile_bindings(&config.app, &prompts);
    reload_bindings(&hc, bindings);
}

/// Initialize the keytap-based global hotkey listener from the current config.
/// Reads config + prompts, builds the initial bindings, starts the resident
/// listener thread, and registers the shared config + manager into Tauri state
/// (the manager's Drop stops the tap, so it must stay alive for the app lifetime).
pub fn setup_keytap_hotkeys(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use crate::app_state::{AppInner, HotkeyManagerState};

    let app_inner = app.state::<Arc<AppInner>>();

    let config = app_inner
        .config_manager
        .load_config()
        .map_err(|e| e.to_string())?;
    let prompts = app_inner.config_manager.load_prompts();
    let (bindings, issues) = compile_bindings(&config.app, &prompts);
    for issue in issues {
        log_hotkey!(warn, "binding issue: {} ({:?})", issue.code, issue.params);
    }

    let hotkey_config = create_config(bindings);
    let hotkey_manager = listener::start_hotkey_listener(hotkey_config.clone(), app.clone())
        .map_err(|e| format!("keytap init failed: {:?}", e))?;

    app.manage(hotkey_config);
    app.manage(HotkeyManagerState {
        _inner: std::sync::Mutex::new(hotkey_manager),
    });

    Ok(())
}

/// Toggle escape-key cancellation on or off.
pub fn set_escape_enabled(config: &HotkeyConfig, enabled: bool) {
    let mut cfg = config.write().unwrap();
    cfg.escape_enabled = enabled;
    drop(cfg);
    sync_suppressed_keys(config);
}

/// Toggle the Enter confirm key on or off.
pub fn set_enter_enabled(config: &HotkeyConfig, enabled: bool) {
    let mut cfg = config.write().unwrap();
    cfg.enter_enabled = enabled;
    drop(cfg);
    sync_suppressed_keys(config);
}

/// Mirror the ESC/Enter gates into keytap's suppressed-key set so those keys
/// never reach the foreground app while they are bound as decision keys —
/// pressing Enter to paste the raw text must not also submit the user's chat
/// message, and cancelling with ESC must not dismiss their dialogs. The keys
/// stay visible to our own listener; only the foreground loses them.
fn sync_suppressed_keys(config: &HotkeyConfig) {
    let (escape_enabled, enter_enabled) = {
        let cfg = config.read().unwrap();
        (cfg.escape_enabled, cfg.enter_enabled)
    };
    let mut keys = Vec::new();
    if escape_enabled {
        keys.push(keytap::Key::Escape);
    }
    if enter_enabled {
        keys.push(keytap::Key::Enter);
        keys.push(keytap::Key::NumpadEnter);
    }
    keytap::set_suppressed_keys(&keys);
}
