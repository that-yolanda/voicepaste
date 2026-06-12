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
pnpm test             # Run all tests (Rust + frontend)
pnpm test:rust        # Run Rust unit tests only
pnpm test:asr         # Run ASR integration tests (requires sherpa-onnx models)
pnpm test:llm         # Run LLM integration tests (requires API keys)
pnpm test:frontend    # Run frontend unit tests only
pnpm test:watch       # Run frontend tests in watch mode
```

## Version Management

**Single source of truth: `package.json` → `"version"`**

Only change the version in `package.json`. The pack script auto-syncs it to `Cargo.toml` before building. `tauri.conf.json` omits `version` — Tauri reads from `Cargo.toml` at build time.

## Architecture

### Rust Backend (`src-tauri/src/`)

- **`lib.rs`** — App entry point. Manages the state machine (`idle → connecting → recording → finishing → idle`), global hotkey registration via `keytap`, system tray, overlay window positioning, and orchestrates the recording lifecycle (start/stop/hold modes).
- **`asr/`** — ASR engine implementations.
  - `mod.rs` — `AsrEngine`, `AsrSession`, `AsrEvent` traits.
  - `doubao.rs` — ByteDance Doubao streaming ASR via WebSocket with custom binary framing protocol (gzip-compressed JSON, 4-byte header). Handles partial/final recognition results, commit-and-await-final flow, and error normalization.
  - `sherpa_onnx/` — Local ASR via sherpa-onnx.
    - `mod.rs` — `SherpaOnnxEngine` entry point, shared JSON helpers, config dispatch by `architecture` and `streaming` capability.
    - `online.rs` — Streaming transducer models (Zipformer). OnlineRecognizer with `hotwords_buf` (in-memory), hotword OOV validation (cjkchar / bpe), post-processing (`restore_hotword_case`).
    - `offline.rs` — Offline common flow: VAD segmentation + OfflineRecognizer worker.
    - `sense_voice.rs` — SenseVoice `OfflineRecognizerConfig` builder (no hotwords).
    - `funasr_nano.rs` — FunASR-Nano config builder + hotwords (comma-separated string in model config).
    - `vad.rs` — Silero VAD wrapper (`VadConfig`, `VadProcessor`). Used by all sherpa-onnx models.
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
│   ├── src/          #   Rust source files + unit tests (inline)
│   │   ├── tests/    #     Integration tests (feature-gated)
│   │   └── asr/      #     ASR engine implementations
│   │       └── sherpa_onnx/  #   Local ASR (sherpa-onnx) sub-modules
│   ├── icons/        #   App icons (generated by `tauri icon`)
│   └── ...
├── web/              # Frontend (vanilla JS, no bundler)
├── build/            # Intermediate build artifacts (gitignored)
├── dist/             # Final distribution artifacts (gitignored)
└── docs/             # Documentation
```

## Code Quality

### Lint & Format

- **Biome** is configured for linting and formatting (`biome.json`)
- After any code change, run `pnpm check` to ensure no lint or formatting issues remain
- Fix all errors and warnings reported by Biome before considering a task complete
- Rust code must compile with zero warnings (`cargo check`)
- `cargo test` must pass with zero failures; `npx vitest run` must pass with zero failures

### Dead Code & Cleanliness

- **Before delivery, all code must be free of**: unused imports, unused variables, unused functions, commented-out code, and debug code
- **Rust production code must NOT use** `#[allow(dead_code)]`, `#[allow(unused_variables)]`, `#[allow(unused_imports)]`, or any `#[allow(unused_xxx)]` to suppress warnings for dead code — delete the dead code instead
- **Acceptable exceptions**: unit test modules, public API exports, and `#[cfg(...)]` conditionally-compiled code may retain internally-unused definitions; add a comment explaining why
- **No debug artifacts**: `dbg!()`, `println!()`, `eprintln!()`, `console.log()` (outside test files) must not be committed — use the project's logging macros (`log_*!`) or remove before delivery

### Test Requirements by Phase

| Phase | Requirement |
|-------|-------------|
| Core feature development | Unit tests for all pure logic functions (parsing, validation, serialization, normalization) |
| Cross-module features | Integration tests as needed (model inference, API calls, multi-module workflows) |
| Before code review | All unit tests must pass (`pnpm test:rust`, `pnpm test:frontend`) |
| Before release | All unit tests AND all integration tests must pass (`pnpm test:rust`, `pnpm test:asr`, `pnpm test:llm`, `pnpm test:frontend`) |

## Testing

### Test Strategy

| Layer | Location | Trigger | Scope |
|-------|----------|---------|-------|
| **Rust unit tests** | Inline at bottom of each `.rs` file: `#[cfg(test)] mod tests { ... }` | `pnpm test:rust` / `cargo test` | Pure logic — parsing, validation, serialization. Uses `tempfile` for file I/O isolation. No network, no models, no API keys. Runs in CI. |
| **Rust integration tests** | `src-tauri/src/tests/` (gated by Cargo features) | `pnpm test:asr` / `pnpm test:llm` | Requires external resources — sherpa-onnx model files (`asr-integration` feature) or LLM API keys (`llm-integration` feature). NOT run in CI. |
| **Frontend tests** | `web/tests/` (Vitest + jsdom) | `pnpm test:frontend` / `npx vitest run` | Component logic, pure functions exported from `app.js`/`settings.js`. Mocks `window.__TAURI__` and Web APIs via `web/tests/helpers/`. |

### Rust Unit Test Conventions

- Follow the Rust official convention: unit tests live **inline** at the bottom of the same source file
- Structure: `#[cfg(test)] mod tests { use super::*; ... }`
- Pure logic functions (parsers, validators, serializers, normalizers) **must** have unit tests
- File I/O tests use `tempfile::tempdir()` for isolation (auto-cleanup)
- HTTP tests use `wiremock` to start a mock server and verify request/response
- Tests for complex types should include round-trip serialization checks

### Rust Integration Test Conventions

- Located in `src-tauri/src/tests/` with feature gates in `Cargo.toml`
- `asr-integration` feature: tests that load sherpa-onnx models and run inference on audio fixtures
- `llm-integration` feature: tests that make real API calls with credentials from environment variables
- Both features are **opt-in** — default `cargo test` skips them entirely
- Integration tests access internal APIs via `use crate::...` (they are part of the library crate)
- Test audio fixtures live in `src-tauri/src/tests/fixtures/`
- ASR models are read from the app data directory (`~/Library/Application Support/com.yolanda.voicepaste/models/`) — tests never download models

### Cargo Features

```toml
[features]
default = []
asr-integration = []   # enables src/tests/asr_integration.rs
llm-integration = []   # enables src/tests/llm_integration.rs
```

### Frontend Test Conventions

- Tests live in `web/tests/<module>.test.js`
- Helpers in `web/tests/helpers/setup-app.js` mock `window.__TAURI__`, `window.voiceOverlay`, `window.voiceSettings`, and Web APIs
- `settings.js` exports pure functions via a `process.env.NODE_ENV === 'test'` guard at the end of the IIFE
- Prioritize testing pure logic functions over side-effect-heavy code

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
- Both `latest.json` (stable) and `latest-beta.json` (beta) must be uploaded to the **stable release** so both URLs resolve
- Each JSON uses a multi-platform `platforms` map — the beta JSON's platform entries point to assets in the prerelease release
- When publishing a beta: create a `--prerelease` release with beta artifacts, then **also upload `latest-beta.json` to the latest stable release** via `gh release upload <stable-tag> latest-beta.json --clobber`
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
