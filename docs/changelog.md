# Changelog

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
