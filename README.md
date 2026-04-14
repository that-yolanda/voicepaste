# VoicePaste

> A macOS voice input tool — press a hotkey, speak, auto-paste.

**[中文](README.zh.md)**

## Features

- **Global Hotkey** — Default F13, customizable in `config.yaml`
- **Real-time ASR** — ByteDance Doubao streaming ASR via WebSocket
- **Auto Paste** — Automatically pastes recognized text into the focused input field
- **Floating Overlay** — Transparent overlay window showing real-time transcription
- **Hotwords** — Custom hotwords to improve recognition accuracy for domain-specific terms
- **System Tray** — Runs in the background, no Dock icon

## Preview

**Voice Input**

![VoicePaste Demo](docs/demo.gif)

**Settings Page**

![VoicePaste Settings](docs/config.png)

## Installation

### Build from Source

```bash
git clone https://github.com/that-yolanda/voicepaste.git
cd voicepaste
pnpm install
pnpm start
```

### Package

```bash
pnpm pack
```

Output is in the `dist/` directory.

## Configuration

Edit `config.yaml` in the project root and fill in your credentials:

| Field | Description |
|-------|-------------|
| `app.hotkey` | Global hotkey, default `F13` |
| `connection.app_id` | Volcengine App ID |
| `connection.access_token` | Volcengine Access Token |
| `connection.secret_key` | Volcengine Secret Key |
| `connection.resource_id` | ASR Resource ID |
| `request.context_hotwords` | Custom hotwords list |

Get your credentials from [Volcengine Voice Service](https://www.volcengine.com/product/voice-service).

## Project Structure

```
voicepaste/
├── main/               # Electron main process
│   ├── main.js         # App entry, state machine & hotkey management
│   ├── asrService.js   # WebSocket ASR client (binary protocol)
│   ├── pasteService.js # Clipboard write + AppleScript paste
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
├── build/              # Build assets (icons, etc.)
├── config.yaml         # Configuration file (fill in credentials)
└── package.json
```

## Tech Stack

- **Electron** — Desktop app framework
- **ByteDance Doubao ASR** — Streaming speech recognition (WebSocket + binary protocol)
- **gzip** — Custom binary framing (4-byte header + compressed JSON)
- **AppleScript** — Simulates Cmd+V paste

## How It Works

```
Press hotkey → Start recording → Mic captures PCM audio → Downsample to 16kHz
  → IPC audio chunks → WebSocket to ASR service
  → Stream back results → Overlay displays text
Press again → Wait for final result → Copy to clipboard → AppleScript Cmd+V paste
```

## System Requirements

- macOS 12+
- Node.js 18+
- pnpm

## Development

```bash
# Run in development mode
pnpm dev

# Package macOS app
pnpm pack
```

## License

[MIT](LICENSE)
