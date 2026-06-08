# Development

## Run Locally

```bash
pnpm install
pnpm dev
```

## Build

```bash
pnpm build              # Production build (tauri build)
```

### Code Signing & Notarization (macOS)

Production builds require code signing and notarization for macOS. Configure via `tauri.conf.json` bundle settings and environment variables.

## Notes

- The project uses Tauri v2 with a vanilla JS frontend (no framework, no bundler).
- `config.yaml` is ignored and meant for local credentials.
- `config.yaml.example` is the shipped default template for packaged builds.
- Current supported desktop platforms are macOS and Windows.

## Project Structure

```text
voicepaste/
├── src-tauri/            # Rust backend (Tauri v2)
│   ├── src/
│   │   ├── lib.rs        # App entry, state machine & hotkey management
│   │   ├── asr.rs        # WebSocket ASR client (binary protocol)
│   │   ├── paste.rs      # Clipboard write + simulated paste + sound
│   │   ├── config.rs     # Config loading, prompts & YAML handling
│   │   ├── commands.rs   # Tauri IPC command handlers
│   │   ├── llm.rs        # LLM text polishing integration
│   │   ├── logger.rs     # File logging
│   │   ├── stats.rs      # Usage statistics & heatmap data
│   │   └── app_state.rs  # Shared application state
│   ├── icons/            # App & tray icons (icns, ico, png)
│   ├── capabilities/     # Tauri permission capabilities
│   ├── Cargo.toml        # Rust dependencies
│   └── tauri.conf.json   # Tauri configuration
├── renderer/             # Frontend (WebView)
│   ├── index.html        # Floating overlay window
│   ├── app.js            # Audio capture & text display
│   ├── settings.html     # Settings page
│   ├── settings.js       # Config editor & UI logic
│   ├── settings.css      # Styles & theme variables
│   ├── theme.css         # Light/dark theme definitions
│   ├── tauri-bridge.js   # IPC bridge (replaces Electron preload)
│   └── lucide-icons.js   # SVG icon definitions
├── docs/                 # User docs, changelog, screenshots
├── config.yaml           # Local runtime config (gitignored)
├── config.yaml.example   # Shipped default config template
└── package.json
```

## Tech Stack

- Tauri v2 (Rust backend + WebView frontend)
- ByteDance Doubao ASR over WebSocket
- gzip-compressed binary framing
- AppleScript on macOS and PowerShell on Windows for paste simulation
- tauri-plugin-global-shortcut for hotkey registration

## Workflow

```text
Press hotkey → Start recording → Mic captures PCM audio → Downsample to 16kHz
  → IPC audio chunks → WebSocket to ASR service
  → Stream back results → Overlay displays text
Press again (or release in hold mode) → Wait for final result → Optional LLM polish → Copy to clipboard → Simulate paste
```

## System Requirements

- macOS 12+ / Windows 10+
- Rust (latest stable)
- pnpm
