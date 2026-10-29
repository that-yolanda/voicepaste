# Changelog

## v2.1.6 (2026-10-29)
This update ships a full English interface with in-app language switching, adds a first-run setup guide, in-app feedback, and pending-update release notes in About, and consolidates the settings pages.

### Added
- **Full Bilingual Interface** — The UI language can now follow the system or be pinned to Chinese / English in settings; every settings page, the tray menu, the voice overlay, and all error messages re-render in the selected language.
- **First-Run Setup Guide** — New users get a bilingual checklist covering microphone permission, recognition model, and hotkey setup. The guide stays available from the sidebar and never interrupts existing users.
- **In-App Feedback** — Report issues and suggestions directly from the app with editable version info, optional diagnostics, and bounded screenshot attachments — no GitHub account needed (delivered through voicepaste.dev).
- **Update Notes in About** — When an update is available, the About panel now shows the pending version's release notes.

### Changed
- **Consolidated Settings** — Sidebar settings and update controls are grouped, model and usage controls moved next to the polishing templates, page state survives settings refreshes without flicker, and controls and labels stay aligned across languages.

### Fixed
- **Log Rotation No Longer Blocks Input** — Rotating the log file used to stall voice input; rotation now happens off the recording path.
- **Credential Redaction** — Provider errors no longer echo API keys, tokens, or service endpoints into log files or the overlay.
- **Polishing Models** — Text polishing now uses the providers' current lightweight models.

### Under the Hood
- Every backend error now crosses the IPC boundary as a structured code and localizes per UI language; the locale files are the single translation source.

## v2.1.5 (2026-10-24)
This update adds ElevenLabs realtime speech recognition, makes the default hotkeys reachable on common keyboards, hardens toggle and hold hotkey handling, and introduces a new logo with a bilingual product website.

### New Features & Improvements
- **ElevenLabs Realtime Speech Recognition** — ElevenLabs can now be selected for realtime speech recognition. Final output comes from server confirmations, so interim text never leaks into what is pasted, confirmed transcripts finish immediately instead of waiting for a fixed timeout, and failed transcriptions are kept for an explicit retry. Model settings add tooltips and visible paid-feature notices.
- **Accessible Default Hotkeys** — The default wake key is now left Command on macOS and left Ctrl on Windows, and left Shift finishes a recording through the general-cleanup template — all reachable on common keyboards. Existing custom bindings are preserved.
- **New Logo and Product Website** — Refreshed the app logo and launched a bilingual product website at voicepaste.dev with interactive demos, setup documentation, a download portal, and release history.
- **Updated Model Details** — Refreshed pricing and capability details for online recognition models and removed obsolete setup guidance.

### Fixed
- **Toggle and Hold Hotkey Conflicts** — Hands-free wake keys are now independent from raw-input shortcuts. Recordings require an exact chord match and a 500ms hold before they start, invalid shortcuts are cleared with a toast when switching modes, and macOS right-side modifiers keep working, with safe recovery when a key release is lost.
- **Windows Shortcut Recording** — Fixed shortcut recording in settings not capturing any keys on Windows while the settings window had focus.
- **Clearer Settings Guidance** — In-app help and the ElevenLabs / Volcengine credential links now open the guides on voicepaste.dev, supported transcript confirmation modes are explained, and ElevenLabs API key setup is documented in both languages.

### Under the Hood
- Added a website workspace with the bilingual product site and download portal; desktop and website checks are now split in CI.
- Updated contribution guidelines for the desktop and website codebases.

## v2.1.4 (2026-10-14)

This update substantially improves voice overlay animations, making appearance, dismissal, and resizing smoother. It also adds polishing failure retry and polishing from history, alongside hotkey improvements.

### New Features & Improvements

- **Voice Overlay Animation Upgrade** — Improved centered fades, scaling, and size transitions on macOS / Windows for smoother appearance, dismissal, and state changes, while keeping the background, text, and indicators aligned throughout.
- **Polishing Failure Retry** — Failed polishing now shows the reason and holds the raw transcript. Press the global main hotkey to retry, `Enter` to output the original text, or `Esc` to discard it. After 5 seconds without input, the original text is delivered automatically, without re-recording. `Enter` and `Esc` can also interrupt an ongoing retry.
- **Polish from History** — Choose a template to polish or re-polish a successful transcription and update the existing entry. New entries retain the template and original transcript, so subsequent polishing uses the original text when available.
- **Contextual Shortcut Hints** — The voice overlay shows relevant cancel, finish, template, and retry shortcuts. Recording hints prioritize the most recently used eligible template, with the template preference retained across restarts.

### Fixed

- **Hotkey Event Filtering** — Added key filtering on macOS / Windows so starting or stopping a recording and handling polishing failures do not also type into the foreground app or trigger its actions. macOS falls back to listening only when Accessibility permission is unavailable.
- **Exact Hotkey Matching** — Extra Ctrl / Alt / Shift / Command modifiers no longer trigger shorter bindings. Character keys in a main hotkey chord are filtered only when the chord matches, preserving ordinary presses of those keys.
- **Hotkey Recording Protection** — Keys are filtered while recording a shortcut in settings to reduce accidental typing and input-method interference. Global main hotkey recordings must start with a function key, Tab, or a modifier; invalid recordings show an explanation and restore the previous setting. Template stop keys still allow ordinary character keys.
- **Polishing Errors and Wait Times** — Distinguishes missing configuration, invalid credentials, unavailable models, incorrect service URLs, rate limits, network failures, and timeouts. Transient errors retry within bounded attempt and time limits. Reasoning is disabled where supported to reduce responses containing reasoning without answer text; truncated output is no longer retried automatically.
- **History Recording Playback** — Playback can now be stopped, and starting another recording stops the previous one. Fixed overlapping playback and stale button states after rapid clicks.
- **History Action Feedback** — Copying, deleting, re-transcribing, and polishing history entries now report success or failure.
- **Overlay Layout Fixes** — Fixed first-frame text truncation and stale animations interfering with a newly shown overlay.
- **Overlay States and Waveform** — Clearer preparation, transcription, polishing, and completion feedback, with more readable shortcut hints across light and dark backgrounds. Both platforms now use consistent rounded waveform animations that activate with sound and settle smoothly during silence, reducing low-level noise triggers.

### Under the Hood

- Unified hotkey filtering through keytap to reduce duplicate system keyboard listeners.
- Fixed Rust formatting and cross-platform Clippy checks, and expanded tests for polishing, hotkeys, and overlay animation and layout.

## v2.1.3 (2026-07-13)

### New Features

- **Hotkey Settings Redesign** — Click the input to record (no more per-row record buttons); the page splits into the global main key and per-feature hotkeys. In hands-free mode the start key is fixed to the global main key, with a separate stop key.
- **Re-transcribe from History** — Entries that kept their recording can be re-transcribed from the saved audio without re-recording.
- **Decoupled Built-in Libraries** — Built-in prompt templates and hotword tables no longer re-merge on startup, so deletions stick; add them on demand via the "常用…" pickers.

### Under the Hood

- Unified prompt hotkey storage as a `+`-joined string; legacy array form auto-migrated.
- Removed the unused `paste_text` command.

## v2.1.2 (2026-07-02)

Hotfix release focused on Windows hotkey recording reliability.

### Fixed

- **Windows Hotkey Recording** — Fixed hotkey recording intermittently failing on Windows. When the settings window had focus, WebView2 blocked the system keyboard hook so key events never reached the recorder; Windows now polls the physical keyboard state directly, bypassing the issue entirely. Alt / F10 are also blocked from activating the WebView2 menu bar, which otherwise paused page scripts and stalled the recording callback.
- **macOS Settings Window** — The settings window now comes to the front reliably on launch and when clicking the Dock icon.
- **Doubao ASR** — Switched the default to non-streaming mode for more stable recognition.

### Under the Hood

- Reorganized the backend into focused modules (recording / hotkey / overlay, …) and removed dead code. No behavior changes.

## v2.1.1 (2026-06-29)

Hotfix release for hotkey reliability.

### Fixed

- **Hotkey Stops Responding** — Fixed the toggle hotkey silently failing when keys like CapsLock or NumLock stayed "held" (their keyup is often dropped by the OS). Non-hotkey keys are now ignored at the source so they can't jam the matcher, and any stuck key is reclaimed automatically after a few seconds idle.

## v2.1.0 (2026-06-27)

This release focuses on performance and stability: the recording path is fully off WebView (audio capture and cues moved into the Rust backend), the macOS overlay no longer depends on a WebView, and the settings window loads on demand — cutting idle memory by ~80MB. It also adds transcription-failure retry and backend hotkey recording.

### New Features

- **Native Audio Capture** — Microphone capture moved entirely to the backend cpal (CoreAudio on macOS, WASAPI on Windows), replacing WebView getUserMedia. Fixes the quiet-then-loud volume ramp that hurt early-word recognition, and removes the browser audio settle delay for a snappier start.
- **Cue Playback** — Start/end cues now play via backend rodio, on a separate channel from mic capture. Native capture has no echo cancellation, so the start cue bleeds into the mic — the leading window is skipped so the cue is never mistaken for speech. Playback is also more stable and on-time, immune to WebView teardown.
- **Backend Hotkey Recording** — Hotkeys are recorded via the backend keytap instead of the DOM, so hardware-level keys the DOM can't see (e.g. macOS Fn) can now be bound.
- **Memory** — The settings WebView is now lazy (destroyed on close, not hidden) and the macOS overlay dropped its WebView, cutting idle memory by ~80MB.
- **Optional Recording Retention** — New "Keep Recordings" option in Settings → App Settings; recordings can be played back from the home history, and failed attempts are kept automatically for retry.
- **Transcription Failure Retry** — On online-ASR connect failure / timeout / empty result, retry by pressing the hotkey again or clicking retry — it re-transcribes the saved audio without re-recording. Commit timeout now returns an error instead of falling back to partial text, so incomplete results are never pasted as success.
- **Overlay UI Polish** — Refined the recording overlay's status hints; the pill now eases open with a transition and hint text breathes, making input feedback feel smoother.

### Fixed

- **Waveform** — Smoother waveform (per-bar frequency bands + asymmetric envelope), with macOS / Windows height computation unified.
- **Settings Always-on-Top** — Fixed the settings window not staying on top when shown at launch or reopened mid-session.
- **Hotkey Symbols** — Fixed Windows showing macOS keyboard symbols; keycaps now render per-platform native glyphs.
- **Hotkey Conflicts & Races** — Reworked into a chord state machine: toggle fires on keyup cycles, hold on keydown, finalizing with the longest chord held during recording; resolves prefix conflicts (e.g. bare Ctrl stealing Ctrl+Shift) and rapid-press races.

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
