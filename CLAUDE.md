# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**VoicePaste** — an Electron desktop app that provides voice-to-text input via a global hotkey. The packaged default config uses `Control+Space`, supports recorded custom key combinations, and auto-pastes recognized text into the currently focused input field. Supports macOS and Windows.

Uses ByteDance Doubao streaming ASR via WebSocket with a custom binary framing protocol (gzip-compressed JSON payloads).

## Commands

```bash
pnpm install          # Install dependencies
pnpm start            # Run the app in development (electron .)
pnpm pack             # Build macOS zip via electron-builder
pnpm pack:win         # Build Windows NSIS installer via electron-builder
```

```bash
pnpm lint          # Biome lint check (main/ preload/ renderer/)
pnpm format        # Biome auto-format (main/ preload/ renderer/)
pnpm check         # Biome check + auto-fix (lint + format)
```

No test framework is configured.

## Architecture

### Main Process (`main/`)

- **`main.js`** — App entry point. Manages the state machine (`idle → connecting → recording → finishing → idle`), global hotkey registration, custom hotkey recording via `uIOhook`, login-item toggle handlers, and orchestrates the recording lifecycle.
- **`asrService.js`** — WebSocket client for Doubao ASR. Implements the binary protocol (4-byte header + payload size + gzip payload). Handles partial/final recognition results, commit-and-await-final flow, and error normalization.
- **`pasteService.js`** — Writes text to clipboard, then simulates paste via platform-specific keystroke (macOS: AppleScript `Cmd+V`, Windows: PowerShell `Ctrl+V`). Restores previous clipboard content after paste.
- **`windowManager.js`** — Creates the frameless overlay window (always-on-top, non-focusable, positioned at screen bottom center) and the settings window.
- **`config.js`** — Loads and parses `config.yaml`. Supports reading, saving, hot-reloading config at runtime, and resetting to defaults from `config.yaml.example`.
- **`logger.js`** — Appends timestamped log lines to `~/Library/Application Support/voicepaste/voicepaste.log`.

### Preload (`preload/preload.js`)

Exposes two `contextBridge` APIs:
- `window.voiceOverlay` — for the overlay renderer (events, audio chunks, config)
- `window.voiceSettings` — for the settings renderer (load/save config YAML, microphone status, reset, accessibility, login item state, custom hotkey recording)

### Renderer (`renderer/`)

Vanilla JS, no framework. Two BrowserWindows:
- **Overlay** (`index.html` + `app.js`) — Floating transparent window. Captures microphone audio via `getUserMedia`, downsamples to 16kHz PCM, sends chunks to main process via IPC. Displays final text (dark) and partial text (light). Auto-resizes window based on text measurement.
- **Settings** (`settings.html` + `settings.js`) — YAML editor for `config.yaml`, microphone permission check, custom hotkey recording, auto-start toggle, and app-level behavior toggles.

### Data Flow

1. Global hotkey → main process state toggle
2. `recording` state → IPC `recording:start` → renderer `getUserMedia` → PCM audio → IPC `asr:audio-chunk` → main process → WebSocket to ASR
3. ASR responses → main process → IPC `overlay:event` → renderer updates text display
4. Second hotkey → `commitAndAwaitFinal()` → wait for final ASR result → clipboard write + simulated paste (AppleScript/PowerShell)

### Configuration (`config.yaml`)

Contains hotkey, app-level behavior toggles (`remove_trailing_period`, `keep_clipboard`), ASR WebSocket URL, resource ID, language settings, hotwords, and auth credentials (app_id, access_token). Bundled as `extraResources` in the built app and loaded at runtime.

- `config.yaml` is in `.gitignore` — used for local development with real credentials
- `config.yaml.example` is the sanitized template (empty credentials)
- Packaging uses `config.yaml.example` as the source for both `config.yaml` and `config.yaml.example` in the bundle, ensuring no real tokens are shipped
- The settings page has a "Reset to Defaults" button that overwrites `config.yaml` with `config.yaml.example` content

## Code Quality

- **Biome** is configured for linting and formatting (`biome.json`)
- After any code change, run `pnpm check` to ensure no lint or formatting issues remain before committing — this catches problems early and keeps the codebase consistent
- Fix all errors and warnings reported by Biome before considering a task complete

## Release

For release work, use the project skill at `.claude/skills/github-release`. It is the source of truth for the full workflow, release notes format, and artifact upload steps.

- Do not push, publish, or upload artifacts without explicit user confirmation
- Ensure version, docs, and artifacts all match the target release version before uploading
- Do not upload partial release assets

## Key Conventions

- Pure CommonJS (`require`/`module.exports`), no ES modules or TypeScript
- No bundler — renderer files are loaded directly by Electron
- Uses `ws` package for WebSocket in main process (Node.js side)
- Cross-platform: paste via AppleScript (macOS) / PowerShell (Windows), mic permissions via `systemPreferences` (macOS only, Windows handled by getUserMedia), hotkeys via Electron `globalShortcut` for string accelerators and `uIOhook` for recorded keycode arrays
- Binary protocol in `asrService.js`: protocol byte `0x11`, message types `0x01` (full request), `0x02` (audio-only), `0x09` (server ack), `0x0f` (error)
