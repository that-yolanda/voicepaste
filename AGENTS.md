# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

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

No test framework or linter is configured.

## Code Commit Convention

- Commit message prefixes must use Conventional Commit style, such as `fix:`, `feat:`, `refactor:`, `docs:`
- When helpful, include the module scope, for example: `fix(hotkey): ...`, `feat(settings): ...`
- The message body after the prefix must explain **why**, not just **what**
- Keep commit messages short, clear, and traceable
- Avoid vague descriptions such as "improve performance", "optimize code", "fix issue"
- Preferred examples:
  - `fix(hotkey): avoid accidental hold trigger while pressing modifier combos`
  - `feat(settings): support hold-to-talk for users who prefer press-and-release input`
- All code comments must be written in English

## Release Checklist

Before publishing a new release, complete the following checks in order:

1. **Confirm version and docs are updated** — Check whether `package.json` version, `README.md`, `README.zh.md`, `CHANGELOG.md`, and `CHANGELOG.zh.md` have all been updated for the new release
2. **Confirm code checks pass** — If the project has code quality checks configured, run the relevant commands and ensure they pass
3. **Confirm all code is committed** — Run `git status` and make sure there are no uncommitted changes
4. **Confirm whether packaging is required** — Ask the user whether this release needs packaged builds; if yes, run `pnpm pack` (macOS) and `pnpm pack:win` (Windows)
5. **Confirm packaged builds were validated by the user** — Ask the user whether the packaged app has been run and validated on the target platform
6. **Confirm whether to push and publish** — Ask the user whether the code should be pushed to GitHub and whether a Release / installer upload should be created

Each step requires explicit user confirmation before continuing.

## Release Artifacts

When publishing a GitHub Release, upload both the installer packages and the platform-specific update metadata files required by `electron-updater`.

- **macOS artifacts** — Upload the macOS package plus `latest-mac.yml`
- **Windows artifacts** — Upload the Windows installer package plus `latest.yml`
- **Do not omit metadata files** — If `latest.yml` or `latest-mac.yml` is missing from the Release, in-app update checks may fail even if the installer itself was uploaded
- **Keep artifacts in the same GitHub Release** — The packaged binaries and their corresponding `latest*.yml` files must belong to the same published version

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

## Key Conventions

- Pure CommonJS (`require`/`module.exports`), no ES modules or TypeScript
- No bundler — renderer files are loaded directly by Electron
- Uses `ws` package for WebSocket in main process (Node.js side)
- Cross-platform: paste via AppleScript (macOS) / PowerShell (Windows), mic permissions via `systemPreferences` (macOS only, Windows handled by getUserMedia), hotkeys via Electron `globalShortcut` for string accelerators and `uIOhook` for recorded keycode arrays
- Binary protocol in `asrService.js`: protocol byte `0x11`, message types `0x01` (full request), `0x02` (audio-only), `0x09` (server ack), `0x0f` (error)
