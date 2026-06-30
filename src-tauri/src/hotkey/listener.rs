//! keytap listener thread: receives raw keyboard events and dispatches matching
//! hotkey actions via the Tauri async runtime.

use keytap::{EventKind, Key, RecvTimeoutError, Tap};
use std::time::{Duration, Instant};

use super::matcher::{is_relevant_hotkey_event, HotkeyAction};
use super::{HotkeyConfig, HotkeyManager};

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
///
/// Forwards raw keytap events to the shared [`MatcherState`] and dispatches
/// the resulting [`HotkeyAction`]s on the async runtime. Escape cancellation
/// and the UI hotkey-recorder relay are handled here, independent of chord
/// matching.
fn run_listener_loop(tap: &Tap, config: &HotkeyConfig, app_handle: &tauri::AppHandle) {
    let mut escape_was_pressed = false;
    // Timestamp of the last received keytap event (any event, even filtered
    // ones — they still prove the user is at the keyboard). When no event has
    // arrived for [`STALE_QUIESCENCE`] yet `held` still holds keys, those keys
    // are stuck (lost keyup) and get reclaimed.
    let mut last_event_at = Instant::now();
    /// How long with zero keyboard activity before stuck `held` keys are reclaimed.
    const STALE_QUIESCENCE: Duration = Duration::from_secs(2);

    loop {
        match tap.recv_timeout(std::time::Duration::from_millis(100)) {
            Ok(event) => {
                last_event_at = Instant::now();
                let event_kind = event.kind;

                // Snapshot all per-event config fields under one read lock
                // (there is no await point between them), instead of three
                // independent reads. `bindings` is reused for both the
                // allowlist check and the matcher, so it is cloned once here.
                let (is_recording, record_tx, escape_enabled, bindings) = {
                    let cfg = config.read().unwrap();
                    (
                        cfg.recording,
                        cfg.record_tx.clone(),
                        cfg.escape_enabled,
                        cfg.bindings.clone(),
                    )
                };

                // While the UI hotkey recorder is capturing a combination,
                // forward every event to it via the relay channel instead of
                // matching bindings. This avoids a second WH_KEYBOARD_LL hook
                // (unreliable on Windows with two taps per process).
                if is_recording {
                    if let Some(tx) = record_tx {
                        // event is Copy — no clone needed.
                        let _ = tx.try_send(event);
                    }
                    continue;
                }

                // Escape cancellation (independent of chord matching).
                if matches!(event_kind, EventKind::KeyUp(Key::Escape)) {
                    escape_was_pressed = false;
                }
                if escape_enabled
                    && matches!(event_kind, EventKind::KeyDown(Key::Escape))
                    && !escape_was_pressed
                {
                    escape_was_pressed = true;
                    let handle = app_handle.clone();
                    tauri::async_runtime::spawn(async move {
                        crate::recording::on_escape(handle).await;
                    });
                }

                // Allowlist: drop events for keys that are not part of any
                // registered binding (CapsLock, NumLock, ordinary typing, …).
                // Such keys can jam the matcher's `held` set when their keyup
                // goes undelivered, so they never enter it.
                if !is_relevant_hotkey_event(event_kind, &bindings) {
                    continue;
                }

                // Drive the state machine under the write lock, then dispatch
                // the emitted actions without holding the lock.
                let actions = {
                    let mut cfg = config.write().unwrap();
                    cfg.matcher.process(event_kind, &bindings)
                };
                for action in actions {
                    match action {
                        HotkeyAction::StartRecording { is_main } => {
                            spawn_recording_start(app_handle, is_main)
                        }
                        HotkeyAction::StopRecording { prompt_id } => {
                            spawn_recording_stop(app_handle, prompt_id)
                        }
                    }
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                // Idle reclaim: with no keyboard activity for a while, any keys
                // still in `held` are stuck (lost keyup). Reclaim them, but
                // only while idle — never during an active recording.
                if Instant::now().duration_since(last_event_at) >= STALE_QUIESCENCE {
                    config.write().unwrap().matcher.clear_stale_held();
                }
                continue;
            }
            Err(RecvTimeoutError::Disconnected) => {
                log_hotkey!(debug, "Tap disconnected, listener thread exiting");
                break;
            }
        }
    }
}

/// Dispatch a "start recording" action to the async runtime.
fn spawn_recording_start(app_handle: &tauri::AppHandle, is_main: bool) {
    let handle = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        crate::recording::on_recording_start(handle, is_main).await;
    });
}

/// Dispatch a "stop recording" action (with the resolved prompt) to the async
/// runtime.
fn spawn_recording_stop(app_handle: &tauri::AppHandle, prompt_id: Option<String>) {
    let handle = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        crate::recording::on_recording_stop(handle, prompt_id).await;
    });
}

/// Reset the matcher's recording tracking. Called by lib.rs when a recording
/// is cancelled, or when a start is diverted to retry or fails, so the matcher
/// does not believe it is still recording.
pub fn reset_recording(config: &HotkeyConfig) {
    config.write().unwrap().matcher.reset_recording();
}
