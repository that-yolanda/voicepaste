# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**VoicePaste** — an Electron desktop app that provides voice-to-text input via a global hotkey. Press F13 (configurable) to start recording, speak, press again to auto-paste the recognized text into the currently focused input field. macOS-only (uses AppleScript for paste simulation and `systemPreferences` for microphone access).

Uses ByteDance Doubao streaming ASR via WebSocket with a custom binary framing protocol (gzip-compressed JSON payloads).

## Commands

```bash
pnpm install          # Install dependencies
pnpm start            # Run the app in development (electron .)
pnpm pack             # Build macOS zip via electron-builder
```

No test framework or linter is configured.

## Architecture

### Main Process (`main/`)

- **`main.js`** — App entry point. Manages the state machine (`idle → connecting → recording → finishing → idle`), global hotkey registration, IPC handlers, system tray, and orchestrates the recording lifecycle.
- **`asrService.js`** — WebSocket client for Doubao ASR. Implements the binary protocol (4-byte header + payload size + gzip payload). Handles partial/final recognition results, commit-and-await-final flow, and error normalization.
- **`pasteService.js`** — Writes text to clipboard, then simulates `Cmd+V` via AppleScript. Restores previous clipboard content after paste.
- **`windowManager.js`** — Creates the frameless overlay window (always-on-top, non-focusable, positioned at screen bottom center) and the settings window.
- **`config.js`** — Loads and parses `config.yaml`. Supports reading, saving, and hot-reloading config at runtime.
- **`logger.js`** — Appends timestamped log lines to `~/Library/Application Support/voicepaste/voicepaste.log`.

### Preload (`preload/preload.js`)

Exposes two `contextBridge` APIs:
- `window.voiceOverlay` — for the overlay renderer (events, audio chunks, resize, config)
- `window.voiceSettings` — for the settings renderer (load/save config YAML, microphone status)

### Renderer (`renderer/`)

Vanilla JS, no framework. Two BrowserWindows:
- **Overlay** (`index.html` + `app.js`) — Floating transparent window. Captures microphone audio via `getUserMedia`, downsamples to 16kHz PCM, sends chunks to main process via IPC. Displays final text (dark) and partial text (light). Auto-resizes window based on text measurement.
- **Settings** (`settings.html` + `settings.js`) — YAML editor for `config.yaml`, microphone permission check, hotkey display.

### Data Flow

1. Global hotkey → main process state toggle
2. `recording` state → IPC `recording:start` → renderer `getUserMedia` → PCM audio → IPC `asr:audio-chunk` → main process → WebSocket to ASR
3. ASR responses → main process → IPC `overlay:event` → renderer updates text display
4. Second hotkey → `commitAndAwaitFinal()` → wait for final ASR result → clipboard write + AppleScript `Cmd+V` paste

### Configuration (`config.yaml`)

Contains hotkey, ASR WebSocket URL, resource ID, language settings, hotwords, and auth credentials (app_id, access_token). Bundled as `extraResources` in the built app and loaded at runtime.

## Key Conventions

- Pure CommonJS (`require`/`module.exports`), no ES modules or TypeScript
- No bundler — renderer files are loaded directly by Electron
- `@xmov/doubao-asr` is a dependency but the actual ASR implementation is custom in `asrService.js`
- Uses `ws` package for WebSocket in main process (Node.js side)
- Mac-only: paste via AppleScript, mic permissions via `systemPreferences`
- Binary protocol in `asrService.js`: protocol byte `0x11`, message types `0x01` (full request), `0x02` (audio-only), `0x09` (server ack), `0x0f` (error)
