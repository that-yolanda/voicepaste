# Changelog

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
