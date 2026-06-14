# Architecture & State Machine

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        FRONTEND (WebView)                        │
│  ┌──────────────────────┐  ┌──────────────────────────────────┐ │
│  │   Overlay Window      │  │   Settings Window                │ │
│  │   (vanilla TS)        │  │   (React 19 + TypeScript)        │ │
│  │                       │  │                                  │ │
│  │  • Audio capture      │  │  • Config pages (9 tabs)         │ │
│  │  • Transcript display │  │  • Model management              │ │
│  │  • Waveform           │  │  • Hotkey recording              │ │
│  └──────────┬───────────┘  └────────────┬─────────────────────┘ │
│             │          Tauri IPC          │                      │
│             │   invoke() + listen()       │                      │
└─────────────┼─────────────────────────────┼──────────────────────┘
              │                             │
┌─────────────┼─────────────────────────────┼──────────────────────┐
│             ▼          BACKEND (Rust)      ▼                      │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │                    Tauri Command Handlers                     ││
│  │  send_audio_chunk │ get_config │ save_config │ download_model ││
│  │  + 24 more IPC commands                                       ││
│  └──────────────────────────┬───────────────────────────────────┘│
│                             │                                    │
│  ┌──────────────────────────▼───────────────────────────────────┐│
│  │                     State Machine                             ││
│  │  Idle ──▶ Connecting ──▶ Recording ──▶ Finishing ──▶ Idle   ││
│  │                    AppState enum + AppInner                   ││
│  └──────┬──────────────────────────────┬────────────────────────┘│
│         │                              │                         │
│  ┌──────▼──────┐              ┌────────▼────────┐                │
│  │  ASR Engine  │              │   LLM Module    │                │
│  │  (trait)     │              │   8 providers   │                │
│  │  ┌──────────┐│              │  OpenAI-compat  │                │
│  │  │ Doubao   ││              └─────────────────┘                │
│  │  │ WebSocket││                                                │
│  │  ├──────────┤│              ┌─────────────────┐                │
│  │  │ sherpa-  ││              │  Paste + Sound  │                │
│  │  │ onnx     ││              │  Clipboard      │                │
│  │  └──────────┘│              │  AppleScript/   │                │
│  └──────────────┘              │  PowerShell     │                │
│                                └─────────────────┘                │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │  ConfigManager │ StatsService │ HotwordManager │ ModelRegistry││
│  │  HotkeyManager │ VoiceLogger  │ Updater                       ││
│  └──────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────┘
```

## State Machine

The recording lifecycle is a 4-state machine defined in `app_state.rs`.

```mermaid
stateDiagram-v2
    [*] --> Idle

    Idle --> Connecting : hotkey pressed (toggle) / hotkey held (hold)
    Connecting --> Recording : audio warmup ready + ASR session created
    Connecting --> Idle : warmup timeout (8s) / warmup failed / escape

    Recording --> Finishing : hotkey pressed (toggle) / hotkey released (hold)
    Recording --> Idle : escape (cancel)

    Finishing --> Idle : final text received + paste complete
    Finishing --> Idle : escape (cancel)
```

**Toggle mode**: press once → start, press again → stop.  
**Hold mode**: hold the key → record, release → stop.  
**Escape**: cancels recording from Connecting, Recording, or Finishing state.

### State Gating

| State | Hotkey Behavior | Audio Input | Overlay Visible | Escape Active |
|-------|----------------|-------------|-----------------|---------------|
| Idle | Start recording | No | No | No |
| Connecting | Cancel | Warming up | Yes | Yes |
| Recording | Stop recording | Streaming | Yes | Yes |
| Finishing | Cancel | Stopped | Yes | Yes |

## Recording Data Flow

```mermaid
sequenceDiagram
    actor User
    participant Hotkey as Hotkey (keytap)
    participant SM as State Machine (lib.rs)
    participant FE as Frontend (WebView)
    participant ASR as ASR Engine
    participant LLM as LLM Module
    participant OS as OS Clipboard

    User->>Hotkey: press hotkey
    Hotkey->>SM: trigger start
    SM->>SM: Idle → Connecting
    SM->>FE: overlay:event (state: connecting)
    SM->>FE: overlay:event (audio:warmup)
    FE->>FE: getUserMedia(), downsample to 16kHz
    FE->>SM: audio_warmup_ready
    SM->>ASR: engine.create_session(hotwords)
    ASR-->>SM: (session, event_receiver)
    SM->>SM: Connecting → Recording
    SM->>FE: overlay:event (state: recording)

    loop Audio streaming
        FE->>SM: send_audio_chunk(base64 PCM)
        SM->>ASR: session.append_audio(samples)
        ASR-->>SM: AsrEvent::Transcript { final, partial }
        SM->>FE: overlay:event (transcript update)
        FE->>FE: render text + waveform
    end

    User->>Hotkey: press again (or release in hold mode)
    Hotkey->>SM: trigger stop
    SM->>SM: Recording → Finishing
    SM->>FE: overlay:event (audio:stop)
    FE->>FE: stop audio capture

    SM->>ASR: session.commit_and_await_final()
    ASR-->>SM: final text

    opt prompt-specific hotkey
        SM->>LLM: call_llm_api(config, text, prompt)
        LLM-->>SM: polished text
    end

    SM->>OS: clipboard.write_text(final_text)
    SM->>OS: simulate_paste() (Cmd+V / Ctrl+V)
    SM->>SM: Finishing → Idle
```

## Window Management

The app has three window-like surfaces:

### Overlay Window
- Transparent, always-on-top, ignores cursor events (clicks pass through)
- Visible on all workspaces (follows Spaces)
- Positioned at bottom-center of the primary monitor's work area (720×300, 48px above bottom)
- Repositioned on every show to follow display changes (external monitor plug/unplug)
- **macOS**: dual rendering — transparent WebView (hidden, acts as audio worker) + native AppKit `NSGlassEffectView` pill for Liquid Glass vibrancy
- **Windows**: WebView-only rendering

### Settings Window
- Standard window hosting the React settings app
- On close (X button): hidden, not destroyed (`api.prevent_close()`)
- Dock icon: shown when settings is open, hidden otherwise

### System Tray
- Two menu items: "Settings" (opens settings window) and "Quit" (exits app)
- Single-instance: `ExitRequested` with `code.is_none()` is prevented to keep app alive in tray

```
┌──────────────────────────────────────────────┐
│                   System Tray                 │
│  ┌─────────┐                                 │
│  │  Tray   │── Settings ──▶ show settings    │
│  │  Icon   │── Quit    ──▶ app.exit(0)       │
│  └─────────┘                                 │
└──────────────────────────────────────────────┘
                          │
                          ▼ (opens)
┌──────────────────────────────────────────────┐
│               Settings Window                 │
│  ┌──────────┐  ┌───────────────────────────┐ │
│  │  Sidebar  │  │  Page Content              │ │
│  │  Home     │  │  (9 pages)                 │ │
│  │  Audio    │  │                             │ │
│  │  Hotkey   │  │                             │ │
│  │  LLM      │  │                             │ │
│  │  ...      │  │                             │ │
│  └──────────┘  └───────────────────────────┘ │
└──────────────────────────────────────────────┘
         Dock icon: visible when settings shown

┌──────────────────────────────────────────────┐
│               Overlay Window                  │
│  (transparent, always-on-top, no cursor)      │
│  ┌────────────────────────────────────────┐  │
│  │  NSGlassEffectView (macOS native)       │  │
│  │  ┌──────────────────────────────────┐  │  │
│  │  │  ●   Transcript text...           │  │  │
│  │  └──────────────────────────────────┘  │  │
│  │  (WebView hidden, used as audio worker) │  │
│  └────────────────────────────────────────┘  │
└──────────────────────────────────────────────┘
```

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **keytap** over `tauri-plugin-global-shortcut` | Supports modifier-only hotkeys and left/right modifier distinction; lower latency via raw keyboard event stream |
| **Trait-based ASR** (`AsrEngine` / `AsrSession`) | Enables swapping between cloud (Doubao) and local (sherpa-onnx) engines without changing the recording loop |
| **WebView as audio worker** on macOS | `getUserMedia` only works in the WebView; the transparent overlay WebView captures audio while the native AppKit view handles display |
| **serde_norway** for YAML | Preserves YAML structure and comments better than serde_yaml; important for user-editable config files |
| **gzip-compressed binary frames** for Doubao | Reduces WebSocket bandwidth for JSON-heavy protocol headers; matches ByteDance's proprietary wire format |
| **Feature-gated integration tests** | ASR and LLM integration tests require external resources (model files, API keys); gating them lets `cargo test` run fast in CI |
