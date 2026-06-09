# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**VoicePaste** — a Tauri v2 desktop app that provides voice-to-text input via a global hotkey. The default hotkey is `F13` (configurable), supports both toggle and hold-to-talk modes, and auto-pastes recognized text into the currently focused input field. Supports macOS and Windows.

Uses ByteDance Doubao streaming ASR via WebSocket with a custom binary framing protocol (gzip-compressed JSON payloads).

## Commands

```bash
pnpm install          # Install dependencies
pnpm dev              # Run the app in development (tauri dev)
pnpm build            # Build for production (tauri build)
pnpm pack             # Build distributable packages (scripts/pack.js)
pnpm pack -s          # Build with macOS code signing and notarization
pnpm pack -p apple_aarch64  # Build specific platform(s)
pnpm clean            # Remove build artifacts and caches
pnpm check            # Biome check + auto-fix (lint + format) on web/
pnpm lint             # Biome lint check
pnpm lint:ci          # Biome CI check (read-only, for CI pipelines)
```

Pack platform keys: `apple_aarch64`, `apple_x64`, `win_x64`. Multiple platforms comma-separated. No `-p` flag builds all.

No test framework is configured.

## Version Management

**Single source of truth: `package.json` → `"version"`**

Only change the version in `package.json`. The pack script auto-syncs it to `Cargo.toml` before building. `tauri.conf.json` omits `version` — Tauri reads from `Cargo.toml` at build time.

## Architecture

### Rust Backend (`src-tauri/src/`)

- **`lib.rs`** — App entry point. Manages the state machine (`idle → connecting → recording → finishing → idle`), global hotkey registration via `keytap`, system tray, overlay window positioning, and orchestrates the recording lifecycle (start/stop/hold modes).
- **`asr.rs`** — WebSocket client for Doubao ASR. Implements the binary protocol (4-byte header + payload size + gzip payload). Handles partial/final recognition results, commit-and-await-final flow, and error normalization.
- **`paste.rs`** — Writes text to clipboard, then simulates paste via platform-specific keystroke (macOS: AppleScript `Cmd+V`, Windows: PowerShell `Ctrl+V`). Also handles sound playback.
- **`config.rs`** — Loads and parses `config.yaml`. Supports reading, saving, and resetting to defaults from `config.yaml.example`. Manages prompt templates (`prompts.json`).
- **`commands.rs`** — Tauri command handlers (IPC). Exposes config, audio, stats, and system commands to the frontend.
- **`llm.rs`** — LLM text polishing integration supporting 8 providers (DeepSeek, OpenAI, Anthropic, Gemini, OpenRouter, SiliconFlow, Ollama, custom).
- **`logger.rs`** — Appends timestamped log lines to the app data directory.
- **`stats.rs`** — Usage statistics tracking (session count, character count, daily heatmap).
- **`app_state.rs`** — Shared application state (AppState enum, ASR session, audio channels).
- **`updater.rs`** — Tauri updater integration. Provides `check_for_update` and `download_and_install_update` IPC commands with progress events.

### Frontend Bridge (`web/tauri-bridge.js`)

Provides `window.voiceOverlay` and `window.voiceSettings` APIs that route through Tauri's `invoke`/`listen` mechanism, replacing the old Electron preload `contextBridge` API.

### Frontend (`web/`)

Vanilla JS, no framework. Two windows:
- **Overlay** (`index.html` + `app.js`) — Floating transparent window. Captures microphone audio via `getUserMedia`, downsamples to 16kHz PCM, sends chunks to backend via IPC. Displays final text and partial text with real-time waveform.
- **Settings** (`settings.html` + `settings.js`) — Full settings UI with home page (statistics/heatmap), hotkey recording, LLM config, sound customization, auto-start toggle, update check, and YAML config editor.

### Hotkey Modes

- **Toggle mode** (default): Press once to start recording, press again to stop and paste.
- **Hold mode**: Hold the key to record, release to stop and paste.
- Supports both simple accelerator strings (`"F13"`, `"Control+Space"`) and recorded custom combinations.
- Prompt templates can have their own hotkeys with independent mode settings.

### Data Flow

1. Global hotkey → backend state change (start/stop based on mode)
2. `recording` state → `audio:warmup` event → frontend `getUserMedia` → PCM audio → `send_audio_chunk` command → backend → WebSocket to ASR
3. ASR responses → `overlay:event` → frontend updates text display
4. Stop → `commitAndAwaitFinal()` → wait for final ASR result → optional LLM processing → clipboard write + simulated paste

### Configuration (`config.yaml`)

Contains hotkey, hotkey mode, app-level behavior toggles (`remove_trailing_period`, `keep_clipboard`), overlay style, sound settings, ASR WebSocket URL, resource ID, language settings, hotwords, and auth credentials. Bundled as Tauri resources.

- `config.yaml` is in `.gitignore` — used for local development with real credentials
- `config.yaml.example` is the sanitized template (empty credentials)
- The settings page has a "Reset to Defaults" button

## Directory Structure

```
voicepaste/
├── assets/           # Source resource files (icons, sounds)
├── scripts/          # Build and utility scripts (pack.js, extract-icons.js, clean.js)
├── src-tauri/        # Rust backend (Tauri v2)
│   ├── src/          #   Rust source files
│   ├── icons/        #   App icons (generated by `tauri icon`)
│   └── ...
├── web/              # Frontend (vanilla JS, no bundler)
├── build/            # Intermediate build artifacts (gitignored)
├── dist/             # Final distribution artifacts (gitignored)
└── docs/             # Documentation
```

## Code Quality

- **Biome** is configured for linting and formatting (`biome.json`)
- After any code change, run `pnpm check` to ensure no lint or formatting issues remain
- Fix all errors and warnings reported by Biome before considering a task complete
- Rust code must compile with zero warnings (`cargo check`)

## Logging

- Use `log_*!` macros from `logger.rs` (e.g., `log_rec!(info, ...)`, `log_asr!(debug, ...)`)
- Format: `[MODULE][LEVEL] message` — modules: App, Recording, ASR, Audio, Hotkey, Events, Tray, Update
- Levels: ERROR (failures), WARN (degraded), INFO (milestones), DEBUG (verbose, dev only)
- Never log ASR recognition text at INFO level — use DEBUG with truncated preview
- File logging (`voicepaste.log`) captures INFO and above; log file rotates at 300KB (gzip to `.log.gz`, 1 backup)
- Default level: Debug in dev builds (`cfg!(debug_assertions)`), Info in release builds
- Do NOT use `eprintln!` / `println!` for logging — always use the `log_*!` macros

## Code Commit Convention

- Commit message prefixes must use Conventional Commit style, such as `fix:`, `feat:`, `refactor:`, `docs:`
- When helpful, include the module scope, for example: `fix(hotkey): ...`, `feat(settings): ...`
- The message body after the prefix must explain **why**, not just **what**
- Keep commit messages short, clear, and traceable
- All code comments must be written in English

## Release

For release work, use the project skill at `.claude/skills/github-release`. It is the source of truth for the full workflow, release notes format, and artifact upload steps.

- Do not push, publish, or upload artifacts without explicit user confirmation
- Ensure version, docs, and artifacts all match the target release version before uploading
- Do not upload partial release assets

### Beta Update Channel

VoicePaste supports a beta update channel for prerelease testing. The architecture is critical to get right:

- **`/releases/latest/` only resolves to the latest non-prerelease release** — there is no static URL for prerelease releases on GitHub
- Both `latest-*.json` (stable) and `latest-beta-*.json` (beta) must be uploaded to the **stable release** so both URLs resolve
- The beta JSON's `url` field points to the actual assets in the prerelease release
- When publishing a beta: create a `--prerelease` release with beta artifacts, then **also upload `latest-beta-*.json` to the latest stable release** via `gh release upload <stable-tag> latest-beta-*.json --clobber`
- `--prerelease` flag ensures the Electron version on `main` branch ignores beta releases
- See `.claude/skills/github-release/SKILL.md` for the full release workflow

## Key Conventions

- Rust backend with Tauri v2 plugins (clipboard-manager, shell, dialog, autostart, updater, process)
- Hotkey registration via `keytap` crate (replaces tauri-plugin-global-shortcut)
- Vanilla JS frontend (no bundler, loaded directly by Tauri WebView)
- `withGlobalTauri: true` — `window.__TAURI__` is available in frontend
- Cross-platform: paste via AppleScript (macOS) / PowerShell (Windows)
- Binary protocol in `asr.rs`: protocol byte `0x11`, message types `0x01` (full request), `0x02` (audio-only), `0x09` (server ack), `0x0f` (error)
- Auto-updates via `tauri-plugin-updater` with GitHub Releases as endpoint
