# Frontend & IPC

## Frontend Architecture

The frontend has two entry points, built by Vite as separate pages:

```
web/
├── index.html                    # Overlay window entry (Windows only)
│   └── src/overlay/index.tsx     #   React 19 + TypeScript (macOS renders natively)
├── settings.html                 # Settings window entry
│   └── src/settings/index.tsx    #   React 19 + TypeScript
├── src/
│   ├── overlay/                  # Overlay React app (Windows only)
│   │   ├── index.tsx             #   OverlayApp root: state + layout + pill
│   │   ├── bridge.ts             #   Overlay IPC wrappers (events + retry)
│   │   ├── types.ts              #   OverlayState / AppState / HintLevel
│   │   ├── useOverlayState.ts    #   overlay:event → reducer; audio:level → bars
│   │   ├── useOverlayLayout.ts   #   measureText → pill width + wrap
│   │   └── overlay.css           #   Overlay-only styles (spin/ring/pulse)
│   ├── settings/                 # Settings React app
│   │   ├── index.tsx             #   Root mount (createRoot)
│   │   ├── SettingsApp.tsx       #   Sidebar + page routing
│   │   ├── SettingsProvider.tsx  #   Shared config + state context
│   │   ├── bridge.ts             #   Settings IPC wrappers
│   │   ├── components/           #   Reusable UI primitives
│   │   │   ├── Button.tsx · Input.tsx · Textarea.tsx · Toggle.tsx
│   │   │   ├── Modal.tsx · SegmentedControl.tsx · Badge.tsx
│   │   │   ├── Heatmap.tsx       #   Calendar heatmap (stats)
│   │   │   ├── KeyCap.tsx        #   Keyboard key display (native modifier glyphs)
│   │   │   └── ModelCard.tsx · ThemeSelector.tsx
│   │   ├── layout/
│   │   │   ├── PageLayout.tsx    #   Page wrapper
│   │   │   └── Sidebar.tsx       #   Navigation sidebar
│   │   ├── lib/                  #   Pure utilities (format, hotkey, hotwords, model, sound, clone)
│   │   ├── pages/                #   Settings pages (9 tabs)
│   │   │   ├── HomePage.tsx      #   Stats + heatmap
│   │   │   ├── AudioModelPage.tsx #  ASR provider + model management
│   │   │   ├── HotkeyPage.tsx    #   Hotkey configuration + recording
│   │   │   ├── LLMPage.tsx       #   LLM provider + prompt config
│   │   │   ├── AppSettingsPage.tsx #  Theme, overlay style, sounds
│   │   │   ├── HotwordsPage.tsx  #   Hotword library management
│   │   │   ├── PermissionsPage.tsx #  Mic + accessibility checks
│   │   │   ├── AboutPage.tsx     #   Version, links
│   │   │   └── FeedbackPage.tsx  #   User feedback
│   │   └── types/                #   TypeScript types (config, hotwords, models, update)
│   └── styles/
│       └── app.css               #   Shared global styles
└── tests/                        # Frontend tests (Vitest + jsdom)
    ├── bridge/
    │   ├── overlay.test.ts
    │   └── settings.test.ts
    └── lib/
        ├── format.test.ts · hotkey.test.ts · hotwords.test.ts · model.test.ts
```

### React Component Tree (Settings Window)

```
SettingsApp
└── SettingsProvider (context: all config + state)
    └── PageLayout
        ├── Sidebar (navigation tabs)
        └── Active Page
            ├── HomePage
            ├── AudioModelPage
            ├── HotkeyPage
            ├── LLMPage
            ├── AppSettingsPage
            ├── HotwordsPage
            ├── PermissionsPage
            ├── AboutPage
            └── FeedbackPage
```

### Overlay Window (React, Windows only)

The overlay is a React app rooted at `web/src/overlay/index.tsx` (`OverlayApp`), used only on Windows. On macOS the overlay is a WebView-less native Window whose pill is rendered by `overlay/macos.rs` (see [Architecture](./architecture.md)). Audio is captured in the backend (cpal); the renderer only paints text, the retry affordance, and a waveform whose per-bar heights the backend pre-computes and ships inside the `audio:level` event.

```
OverlayApp  (web/src/overlay/index.tsx)
├── useOverlayState   (overlay:event reducer: reset/state/transcript/hint;
│                      audio:level → waveHeights[]; retry auto-hide 5s)
├── useOverlayLayout  (measureText → pill width + single/multi wrap)
├── getOverlayLayoutMetrics()  (fetch shared::LayoutMetrics from backend on mount)
└── pill  (data-wrap drives single-line vs multi-line CSS)
    ├── indicator   (spinner while connecting/finishing; red dot on error;
    │                hidden while recording — the waveform takes its slot)
    ├── waveform    (4 fixed bars, scaleY from backend heights)
    ├── body        (transcript final+partial OR hint text — mutually exclusive)
    └── retry button (error + retryable only; calls retryLatestFailedTranscription)
```

## IPC Bridge Design

Communication uses two complementary Tauri primitives:

### invoke (Request-Response)

Frontend calls typed async wrappers that map to `#[tauri::command]` functions in `commands.rs`:

```
Frontend                          Backend
───────                          ───────
overlay/bridge.ts                  commands.rs
  getOverlayLayoutMetrics() ─────▶ get_overlay_layout_metrics()
  retryLatestFailedTranscription() ─▶ retry_latest_failed_transcription()

settings/bridge.ts                commands.rs
  getData() ───────────────────▶ get_settings_data()
  saveConfigObject() ──────────▶ save_config_object()
  getStats() ──────────────────▶ get_stats()
  downloadModel() ─────────────▶ download_model()
  ...                             ...
```

28 commands are registered in `lib.rs` via `tauri::generate_handler![]`.

### listen / emit (Event-Driven)

The backend emits events; the frontend subscribes:

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `overlay:event` | Backend → Frontend | State changes, transcript text, audio lifecycle, appearance |
| `settings:event` | Backend → Frontend | Theme changes after config save |
| `model:download:progress` | Backend → Frontend | ASR model download progress |
| `update:progress` | Backend → Frontend | App update download progress |

### Event Flow

```mermaid
sequenceDiagram
    participant BE as Backend (Rust)
    participant Tauri as Tauri Event Bus
    participant FE as Frontend (WebView)
    participant Native as macOS Native (AppKit)

    BE->>Tauri: app.emit("overlay:event", payload)
    Tauri->>FE: listen("overlay:event", ...)
    Tauri->>Native: listen_any("overlay:event", ...)
    FE->>FE: Update DOM (text, state, waveform)
    Native->>Native: Update NSGlassEffectView pill

    Note over Tauri,Native: Same event stream drives both renderers
```

## Audio Capture Pipeline

Audio is captured in the **backend** via cpal (CoreAudio on macOS, WASAPI on Windows), not in the WebView. This keeps mic capture off the renderer thread and lets the macOS overlay drop its WebView entirely.

```mermaid
sequenceDiagram
    participant Mic as Microphone
    participant BE as Backend (cpal)
    participant ASR as ASR Engine
    participant FE as Overlay (Windows) / Native (macOS)

    BE->>Mic: cpal input stream (16kHz, mono, f32)
    loop Every chunk (~100ms / 1600 samples)
        Mic->>BE: f32 samples
        BE->>BE: compute_audio_level → emit overlay:event (audio:level)
        BE->>ASR: session.append_audio(samples)
        ASR-->>BE: AsrEvent::Transcript
        BE->>FE: emit overlay:event (transcript / audio:level)
    end
```

The frontend no longer ships PCM helpers — `web/src/lib/audio.ts` was removed when capture moved to the backend.

## Overlay Window

### Window properties (both platforms)

- Transparent window (created in code; tauri.conf.json `create: false`)
- Ignores cursor events — clicks pass through (re-enabled only for the retry button)
- Visible on all workspaces — follows macOS Spaces
- Positioned at bottom-center of primary monitor (720×300, 48px above bottom)
- Repositioned on every show to handle display changes (external monitor)

### macOS — native Liquid Glass (no WebView)

The overlay is a WebView-less native `Window`. `overlay/macos.rs` paints an AppKit pill inside an `NSGlassEffectView`, driven by the same `overlay:event` stream tapped via `app.listen_any`:

```
overlay:event ──▶ NSGlassEffectView (visible, native Liquid Glass)
                   ├── indicator (dot / spinner)
                   ├── NSTextField (transcript, max 3 lines)
                   └── waveform bars + retry button
```

The `NSWindow` is reached via `raw-window-handle` (`AppKit.ns_view` → `[ns_view window]`), since `WebviewWindow::ns_window` no longer applies to this WebView-less window.

### Windows — React overlay

The overlay is a `WebviewWindow` running the React app above. `overlay:event`s drive React state → the pill's `data-wrap` attribute (single- vs multi-line), with CSS doing the visual switching. Layout constants (padding, indicator/wave/retry sizes, max widths) come from the backend `get_overlay_layout_metrics` command (`overlay/shared.rs::LayoutMetrics`) — the same struct the macOS renderer consumes, so both platforms share one source of truth. The pill auto-sizes: single-line for short text, up to 3 lines for longer content.

## Paste Mechanism

Defined in `paste.rs`. The `simulate_paste()` function is platform-specific:

### macOS
```rust
// AppleScript: tell application "System Events" to keystroke "v" using command down
Command::new("osascript")
    .args(["-e", "tell application \"System Events\" to keystroke \"v\" using command down"])
```

### Windows
```rust
// PowerShell: Add-Type → [System.Windows.Forms.SendKeys]::SendWait("^v")
Command::new("powershell")
    .args(["-Command", "..."])
```

### Flow

1. `stop_recording` writes final text to clipboard via `tauri-plugin-clipboard-manager`
2. `simulate_paste()` triggers Cmd+V / Ctrl+V via OS automation
3. If paste fails (e.g. macOS accessibility permission denied), `PasteResult.permission_error` is set to `"accessibility"` so the frontend can guide the user

### Sound Playback

Sound files (start.mp3, end.mp3) are played via `rodio` in `sound.rs`
(cross-platform; replaces the former per-platform `afplay` / PowerShell paths).

Sound plays at recording start and optionally after paste completion.
