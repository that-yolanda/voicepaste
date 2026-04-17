# Development

## Run Locally

```bash
pnpm install
pnpm dev
```

## Package

```bash
# Package macOS app
pnpm pack

# Package Windows installer
pnpm pack:win
```

## Notes

- The project uses Electron with plain CommonJS and no frontend bundler.
- `config.yaml` is ignored and meant for local credentials.
- `config.yaml.example` is the shipped default template for packaged builds.
- Current supported desktop platforms are macOS and Windows.

## Project Structure

```text
voicepaste/
├── main/               # Electron main process
│   ├── main.js         # App entry, state machine & hotkey management
│   ├── asrService.js   # WebSocket ASR client (binary protocol)
│   ├── pasteService.js # Clipboard write + simulated paste
│   ├── windowManager.js# Window creation & management
│   ├── config.js       # Config loading & hot-reload
│   └── logger.js       # Logging module
├── preload/            # Preload scripts
│   └── preload.js      # contextBridge API
├── renderer/           # Renderer process
│   ├── index.html      # Floating overlay window
│   ├── app.js          # Audio capture & text display
│   ├── settings.html   # Settings page
│   ├── settings.js     # Config editor
│   └── settings.css    # Settings page styles
├── build/              # Build assets
├── docs/               # User docs, changelog, screenshots
├── config.yaml         # Local runtime config
├── config.yaml.example # Shipped default config template
└── package.json
```

## Tech Stack

- Electron
- ByteDance Doubao ASR over WebSocket
- gzip-compressed binary framing
- AppleScript on macOS and PowerShell on Windows for paste simulation
- `uIOhook` for recorded custom hotkey combinations

## Workflow

```text
Press hotkey → Start recording → Mic captures PCM audio → Downsample to 16kHz
  → IPC audio chunks → WebSocket to ASR service
  → Stream back results → Overlay displays text
Press again → Wait for final result → Copy to clipboard → Simulate paste
```

## System Requirements

- macOS 12+ / Windows 10+
- Node.js 18+
- pnpm
