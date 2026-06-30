# Global Hotkey System

## Overview

VoicePaste uses the `keytap` crate for global hotkey registration, replacing `tauri-plugin-global-shortcut`. This enables modifier-only hotkeys, left/right modifier distinction, and lower latency via raw keyboard event streaming.

## Architecture

```
┌─────────────────────────────────────────────────┐
│             HotkeyManager                        │
│  (owns nothing — listener thread runs forever)   │
└────────────────────┬────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────┐
│         HotkeyConfig (Arc<RwLock<...>>)          │
│  ┌────────────────────────────────────────────┐  │
│  │  bindings: Vec<HotkeyBinding>               │  │
│  │  matcher: MatcherState   (chord state machine)│
│  │  escape_enabled: bool                       │  │
│  │  tap_active: bool                           │  │
│  │  recording / record_tx   (UI recorder relay) │  │
│  └────────────────────────────────────────────┘  │
└────────────────────┬────────────────────────────┘
                     │ shared with listener thread
                     ▼
┌─────────────────────────────────────────────────┐
│     Listener Thread ("voicepaste-hotkey")        │
│  ┌────────────────────────────────────────────┐  │
│  │  run_listener_loop(tap, config, app_handle) │  │
│  │                                            │  │
│  │  loop {                                    │  │
│  │    tap.recv_timeout(100ms)                 │  │
│  │    → forward to recorder if recording      │  │
│  │    → handle Escape cancellation            │  │
│  │    → matcher.process(event) → HotkeyAction │  │
│  │    → dispatch Start/StopRecording to async │  │
│  │  }                                         │  │
│  └────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

### HotkeyBinding

```rust
struct HotkeyBinding {
    keys: BTreeSet<Key>,     // All keys that must be held simultaneously
    mode: String,            // "toggle" or "hold"
    prompt_id: Option<String>, // None = main hotkey, Some(id) = prompt hotkey
}
```

## Hotkey Modes

```mermaid
stateDiagram-v2
    [*] --> Idle

    state "Toggle Mode" as Toggle {
        Idle --> Recording : keyup cycle completes (start)
        Recording --> Idle : keyup cycle completes (stop)
        Recording --> Idle : escape
    }

    state "Hold Mode" as Hold {
        Idle --> Recording : keydown (hold chord completes)
        Recording --> Idle : release (any chord key)
        Recording --> Idle : escape
    }
```

In both modes recording starts **neutral** — the prompt is decided when the
recording ends, from the longest chord held at that point (see below).

### How Mode Dispatch Works

A pure state machine, `MatcherState` (held under `HotkeyConfig`), consumes every
keytap event and emits zero or more `HotkeyAction`s:

- `StartRecording { is_main }` — begin a **neutral** recording (prompt undecided)
- `StopRecording { prompt_id }` — end the recording; finalize with this prompt

`longest_match(held, bindings)` resolves chord conflicts: of all bindings whose
keys are a subset of the currently held keys, the one with the most keys wins;
ties break by registration order (main hotkey first). This replaces the old
first-subset match that let a bare `Ctrl` steal `Ctrl+Shift`.

**Hold**: the moment a hold chord's keys are all pressed (keydown), recording
starts — zero latency, prompt undecided. It ends when any of those keys is
released; the prompt is the longest chord reached during the hold (the peak).

**Toggle**: a press cycle is the span from the first keydown to the held set
emptying at keyup. Recording starts when the start cycle completes (if it
reached a toggle chord), and stops when the next cycle completes. The prompt is
the longest chord reached during the **stop** cycle — so starting with
`Ctrl+Shift` but stopping with plain `Ctrl` yields raw output, and vice versa.

Because the chord is fully known at the stop/peak moment, prefix conflicts
resolve correctly with **no timeout and no pending**.

The start/stop logic in `lib.rs`:
- `on_recording_start(is_main)`: if the main hotkey was used while a retryable
  failure is shown, retry it instead; otherwise `start_recording()`. If the
  start is diverted to retry or fails, the matcher is reset so it doesn't think
  a session is active.
- `on_recording_stop(prompt_id)`: set `ActivePromptId`, then `stop_recording()`.

### Escape Cancellation

When the state machine is in Connecting, Recording, or Finishing state, pressing Escape triggers `cancel_recording()`. The `escape_enabled` flag on `HotkeyConfig` is toggled by `sync_escape_shortcut()` during state transitions.

Escape uses a `was_pressed` guard to prevent key-repeat from triggering multiple cancellations.

Because ESC cancels out-of-band (not via a stop chord), `cancel_recording()` also calls `reset_recording()` to clear the matcher's session tracking, so the next keypress isn't mistaken for a stop.

## Hotkey Parsing

The `parse_hotkey_string()` function converts human-readable hotkey strings into `BTreeSet<Key>`:

| Format | Example | Result |
|--------|---------|--------|
| Function key | `"F13"` | `{Key::F13}` |
| Modifier + key | `"Control+Shift+A"` | `{ControlLeft, ShiftLeft, A}` |
| Side-specific | `"ShiftRight+F"` | `{ShiftRight, F}` |
| Aliases | `"Ctrl+C"`, `"Cmd+V"` | `{ControlLeft, C}`, `{MetaLeft, V}` |
| Cross-platform | `"CmdOrCtrl+S"` | `{MetaLeft, S}` (macOS) / `{ControlLeft, S}` (Windows) |
| Special keys | `"Space"`, `"Enter"`, `"Escape"` | Respective Key variants |

Supported modifier aliases: `Ctrl`/`Control`, `Shift`, `Alt`/`Option`, `Cmd`/`Super`/`Meta`/`Command`.
For side-specific modifiers: `ControlLeft`, `ShiftRight`, `AltLeft`, `CmdRight`, etc.

## Per-Prompt Hotkeys

Each prompt in `prompts.json` can have its own hotkey and mode:

```json
{
  "id": "polish-en",
  "name": "English Polish",
  "prompt": "Polish this text to sound professional.",
  "hotkey": "Control+Shift+E",
  "hotkey_mode": "hold"
}
```

Recording always starts **neutral** — the prompt is decided by the stop chord
(the longest chord held when the recording ends), not by the key that started
it. When a prompt-specific stop chord is used, `on_recording_stop` sets
`active_prompt_id` to `Some("polish-en")` and `finalize_and_paste` runs the LLM
polish; a main-hotkey stop (`active_prompt_id = None`) pastes raw text.

Before polishing, `finalize_and_paste` validates the LLM config — if it's
incomplete (missing key/URL/model), it downgrades to raw text with a warning
instead of letting the call fail.

## Frontend Hotkey Recording

The settings UI (`HotkeyPage.tsx`) records new hotkeys via DOM capture-phase keyboard events:

1. User clicks "Record" button
2. Capture-phase `keydown` events collect pressed keys
3. `keyup` finalizes the combination
4. Keys are sorted canonically (modifiers first, then main key)
5. Display string is generated for the UI
6. Result is saved to `config.yaml` as a string like `"Control+Shift+A"`

Key behaviors:
- Space key's `preventDefault` only on non-Mac platforms (avoids suppressing keyup on Mac)
- 300ms timeout after last keydown before auto-finalizing
- Left/right modifier distinction is preserved

### Display: native modifier glyphs

Recorded combinations render through the `KeyCap` component (`settings/components/KeyCap.tsx`), which shows platform-native modifier symbols instead of generic text:

- **macOS**: ⌘ (Cmd), ⌃ (Control), ⇧ (Shift), ⌥ (Option/Alt)
- **Windows**: Ctrl, Alt, Shift, Win (Super)

The symbol set is chosen per-platform so the on-screen keycaps match the user's physical keyboard labels.

## Hot Reload

When the user saves settings:
1. `save_config_object()` writes `config.yaml`
2. `reload_hotkey_bindings()` is called, which rebuilds the binding list from the new config
3. The listener thread picks up the new bindings on its next iteration (no restart needed)
4. `MatcherState` is preserved across reloads (an in-flight session keeps its tracking); reload mid-recording is not expected
5. If bindings haven't changed, the reload is a no-op

### Permission Recovery

If `keytap::Tap::new()` fails with `PermissionDenied`, the app starts without hotkeys rather than crashing. The user can grant Accessibility/Input Monitoring permission and use the "Reinitialize" button in settings, which calls `ensure_hotkey_active()` to create a new tap.
