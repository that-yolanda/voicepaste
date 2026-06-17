# Changelog

## v2.0.0 (2026-06-17)

> **⚠️ BREAKING CHANGE**: VoicePaste has been completely rewritten from Electron to Tauri v2 (Rust backend). This is a major architecture change. Config from 1.x is automatically migrated on first launch.

### Architecture

- **Electron → Tauri v2** — Entire app rebuilt with Tauri v2 (Rust + WebView). Installer reduced from ~120 MB to ~20 MB, idle memory from ~500 MB to ~80 MB.
- **Apple Signed & Notarized** — macOS builds are signed and notarized with an Apple Developer certificate — no Gatekeeper warnings on install.
- **React / TypeScript Frontend** — Settings UI rebuilt with React + TypeScript + Tailwind CSS. Unified design system with light / dark / system theme support.

### ASR Speech Recognition

- **Dual Engine (Cloud + Local)** — Online: ByteDance Doubao streaming ASR with new API Key authentication. Local: sherpa-onnx with 4 offline models.
- **4 Local Models** — SenseVoice (ZH/EN/JP/KO/Cantonese), Zipformer (ZH + EN bilingual), FunASR-Nano (ZH/EN + 7 dialects), Qwen3-ASR-0.6B (30 languages). On-demand loading, 500 MB+ memory, CPU / CUDA / CoreML acceleration.
- **VAD + Punctuation** — Built-in Silero VAD (Voice Activity Detection) for audio segmentation; optional Punctuation model for post-processing.
- **Simulated Streaming** — Local models without native streaming get real-time partial results via VAD-based segmented decoding.
- **Auto-Reconnect** — Online model auto-reconnects on disconnection for reliable long recordings.
- **Dual Auth Compatibility** — Supports both the new Volcengine API Key flow and the legacy APP ID / Access Token / Secret Key flow.

### LLM Text Polishing

- **8 LLM Providers** — DeepSeek, OpenAI, Anthropic, Gemini, OpenRouter, SiliconFlow, Ollama, and OpenAI-compatible APIs.
- **Custom Prompt Templates** — Built-in templates for general cleanup, translation, email drafting, and more. Customizable prompts with per-template hotkey bindings.
- **Hotword Boosting** — Three modes (Auto / Enabled / Disabled) to append hotwords to the LLM prompt for stronger recognition accuracy.

### Hotwords

- **Multi-Group Libraries** — Create multiple hotword groups and switch between them.
- **Weight Parameter** — `hotword|weight` format with 1–10 range.
- **Batch Add** — Comma-separated input for adding multiple hotwords at once.
- **Format Restoration** — Automatically restores original formatting (capitalization, punctuation, special characters) after recognition.
- **Online Hotword Table** — Volcengine online hotwords work alongside local hotwords; local takes priority.

### Hotkey System

- **keytap Native Engine** — Replaces uiohook-napi / tauri-plugin-global-shortcut. Supports modifier-only bindings and precise left/right key distinction.
- **Toggle & Hold Modes** — Toggle (press to start, press again to stop) and Hold (press and hold to speak, release to stop). ESC to cancel.
- **Per-Template Hotkeys** — Bind independent hotkeys to different text polishing templates, each with its own trigger mode.

### Configuration System

- **registry.json Model Registry** — All model defaults managed in one place. Users only override what they need in config.yaml.
- **Three-Layer Merge** — Shared defaults → model-specific defaults → user overrides. Unset fields fall through automatically.
- **Hot Reload** — Changes take effect immediately on save — no restart required.
- **1.x Config Migration** — Automatically imports Electron-era config on first v2.0 launch.

### Other

- **Beta Update Channel** — Opt in via settings to receive beta release notifications. Stable users are unaffected.
- **Structured Logging** — Leveled, module-prefixed logging with file rotation (300KB, gzip) for easier troubleshooting.
- **Custom Sound Effects** — Replace the default start/end sounds with your own audio files.
- **Keep Clipboard** — Optionally keep results in the clipboard without auto-pasting.
- **macOS Liquid Glass Overlay** — Native AppKit Liquid Glass transparent overlay with light/dark/system theme support.
- **Configuration Guide** — New [GUIDANCE.md](GUIDANCE.md) covering quick start, model setup, hotwords, LLM, and all features.

## v1.2.0 (2026-05-26)

- **LLM Text Polishing** — Integrate Vercel AI SDK with 8 provider support (DeepSeek, OpenAI, Anthropic, Gemini, OpenRouter, SiliconFlow, Ollama, custom OpenAI-compatible) for post-processing ASR output (formatting, polishing, translation, etc.).
- **Prompt Template Management** — New `prompts.json` for managing multiple prompt templates, each with its own hotkey binding and trigger mode for different polishing scenarios.
- **Real-time Audio Waveform** — Live audio waveform visualization in the floating overlay during recording.
- **Notification Sounds** — Distinct start and end sounds to indicate recording readiness and recognition success.
- **DMG Build Output** — Added DMG format for macOS builds, fixing auto-update failures on read-only volumes.
- **Settings UI Polish** — Multi-provider selector, prompt template editor, refined hotkey keycap display with subtle superscript for left/right modifier distinction.

## v1.1.0 (2026-05)

- **Settings Home Page** — Added a home page with usage statistics, activity heatmap, and input history for a quick overview of your voice input activity.
- **Unified Pack Command** — Build macOS arm64 and x64 in a single `pnpm run pack` command, simplifying the release process.
- **Settings Redesign** — Reorganized settings page with sidebar navigation and auto-save for a cleaner editing experience.
- **Auto-Update Fix** — Prevented the auto-update check from re-triggering when saving config, avoiding unnecessary network requests.
- **CI & Release Overhaul** — Unified the pack script, added CI pipeline, and revamped the release skill for a more reliable build process.

## v1.0.8 (2026-04)

- **Update Install Fix** — Fixed auto-update restart not quitting on macOS (Electron 41) by explicitly calling `app.quit()` after `quitAndInstall()`.
- **Tray Cleanup** — Destroy the system tray before restart to prevent the app from hanging during auto-update install.
- **Simplified Update UI** — Consolidated check/download/install into a single state-driven button with progress and auto-recovery.
- **Update Diagnostics** — Added Squirrel.Mac native updater event listeners and install-flow logging for troubleshooting.

## v1.0.7 (2026-04)

- **Faster Startup** — WebSocket connection and audio device initialization now run in parallel during the "connecting" phase, reducing the delay from hotkey press to recording start.
- **CJK Text Fix** — Removed unwanted spaces between consecutive Chinese/CJK characters in ASR recognition results.

## v1.0.6 (2026-04)

- **Hold-to-talk Mode** — Added `app.hotkey_mode` with `toggle` and `hold` modes, including settings UI support for press-and-hold voice input.
- **Hotkey Precision** — Recorded left/right modifier keys are now matched exactly, so left and right `Ctrl` / `Shift` / `Alt` / `Command` no longer trigger each other.
- **Overlay Readiness** — The overlay now turns green only after audio capture actually starts sending data, making the status indicator closer to real recording readiness.
- **Hold-mode Stability** — Short hold cancellation no longer emits a spurious WebSocket error while the ASR connection is still opening.
- **Faster Startup** — Reduced audio chunk size to improve perceived startup latency when recording begins.
- **Settings UI Cleanup** — Split the old “General” section into “Hotkey” and “App Settings”, simplified hotkey hints, and updated the config-path field presentation.

## v1.0.5 (2026-04)

- **Windows Fix** — Resolved "not a valid Win32 application" error caused by macOS-compiled `uiohook-napi` native module being packaged into the Windows installer. Added `prepack:win` script to clean the build directory before packaging, allowing the correct Windows prebuild to load at runtime.

## v1.0.4 (2026-04)

- **Theme Support** — Light / dark / system theme preference in settings, persisted via `app.theme`
- **Unified Color System** — `theme.css` as the single source of truth for overlay and settings windows
- **Settings UI Polish** — Restructured toggle layout (title left, switch right, field path below), theme selector as inline button group, removed verbose descriptions
- **Overlay Fix** — Reset card dimensions on hide to prevent flash of stale size
- **Build Fixes** — Disabled native rebuild for Windows packaging, fixed startup crash and ASR config error handling
- **Code Quality** — Added @biomejs/biome for linting and formatting

## v1.0.3 (2026-04)

- **Custom Hotkey Recording** — Added settings-based hotkey recording with `uIOhook`, including support for custom key combinations
- **Auto Start** — Added login item toggle in settings for launching VoicePaste at system startup
- **Clipboard Control** — Added `app.keep_clipboard` so the recognized result can stay in the clipboard after paste
- **Trailing Period Cleanup** — Added `app.remove_trailing_period` to strip trailing `。` / `.` from final output
- **Config Template** — Updated `config.yaml.example` to document the default hotkey and new app-level options
- **Platform Notes** — README and settings behavior are now aligned with macOS and Windows support

## v1.0.2 (2025-04)

- **UI Redesign** — New Claude-inspired interface with warm minimalism color palette
- **Overlay Optimization** — Eliminated text flickering during speech, smooth horizontal expansion animation
- **Cross-platform Fonts** — Unified sans-serif font stack for macOS / Windows
- **External Links** — Settings page links now open in the system default browser
- **Settings Page** — Added GitHub repo link, unified terra cotta section theme
- **FAQ** — Added common questions (macOS permissions, non-stream hotwords, Windows compatibility)

## v1.0.0 (2025-03)

- Initial release
- Global hotkey voice input
- ByteDance Doubao streaming ASR
- Auto-paste into the focused input field
- Floating overlay with real-time transcription
- Hotword support
