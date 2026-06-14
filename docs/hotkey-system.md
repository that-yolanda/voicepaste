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
│  │  escape_enabled: bool                       │  │
│  │  tap_active: bool                           │  │
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
│  │    → track held keys (HashSet<Key>)        │  │
│  │    → match against bindings                │  │
│  │    → dispatch press/release to async rt    │  │
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
        Idle --> Recording : press (any matching binding)
        Recording --> Idle : press (same binding)
        Recording --> Idle : escape
    }

    state "Hold Mode" as Hold {
        Idle --> Recording : press and hold (any matching binding)
        Recording --> Idle : release
        Recording --> Idle : escape
    }
```

### How Mode Dispatch Works

The listener thread tracks all currently held keys via a `HashSet<Key>`. On each key down/up event:

1. Update `held` set
2. Find first matching binding: `find_matching_binding(&held, &bindings)` → `Option<usize>`
3. Compare with `active_binding`:
   - **No match → match** (press): `spawn_hotkey_pressed(mode, prompt_id)`
   - **Match → no match** (release): `spawn_hotkey_released(mode)`
   - **Match A → Match B** (transition): release A, then press B

The actual start/stop logic in `lib.rs`:
- `on_hotkey_pressed`: if idle → `start_recording(prompt_id)`; if recording in toggle mode → `stop_recording()`
- `on_hotkey_released`: if recording in hold mode → `stop_recording()`

### Escape Cancellation

When the state machine is in Connecting, Recording, or Finishing state, pressing Escape triggers `cancel_recording()`. The `escape_enabled` flag on `HotkeyConfig` is toggled by `sync_escape_shortcut()` during state transitions.

Escape uses a `was_pressed` guard to prevent key-repeat from triggering multiple cancellations.

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

### Legacy Format Support

Prompt hotkeys can also use the legacy uIOhook keycode format (integer array):

```yaml
# New format (preferred)
hotkey: ["Control+Shift+A"]

# Legacy format (still supported)
hotkey: [29, 46, 4]  # Control, Shift, A
```

`parse_prompt_hotkey_to_keys()` tries string format first, then falls back to keycode mapping.

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

When triggered, the recording uses the prompt's system prompt for LLM polishing, instead of bypassing LLM like the main hotkey does. The `active_prompt_id` is set to `Some("polish-en")` and checked in `stop_recording()`.

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

## Hot Reload

When the user saves settings:
1. `save_config_object()` writes `config.yaml`
2. `reload_hotkey_bindings()` is called, which rebuilds the binding list from the new config
3. The listener thread picks up the new bindings on its next iteration (no restart needed)
4. If bindings haven't changed, the reload is a no-op

### Permission Recovery

If `keytap::Tap::new()` fails with `PermissionDenied`, the app starts without hotkeys rather than crashing. The user can grant Accessibility/Input Monitoring permission and use the "Reinitialize" button in settings, which calls `ensure_hotkey_active()` to create a new tap.
