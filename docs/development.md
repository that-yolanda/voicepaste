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

### Code Signing & Notarization (macOS)

Without any configuration, the build will use ad-hoc signing and skip notarization. This works for personal use but macOS will reset permissions (microphone, accessibility) on each reinstall.

To enable proper code signing and notarization:

1. Obtain a **Developer ID Application** certificate from [developer.apple.com](https://developer.apple.com) and install it in Keychain.
2. Generate an **App Specific Password** at [appleid.apple.com](https://appleid.apple.com) → App Specific Passwords.
3. Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

```env
APPLE_ID=your-apple-id@example.com
APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
APPLE_TEAM_ID=XXXXXXXXXX
CSC_NAME=Developer ID Application: Your Name (TEAMID)
# Optional: set to false to fail fast instead of auto-picking a different cert
# CSC_IDENTITY_AUTO_DISCOVERY=false
```

4. Run `pnpm pack`:
   - If `CSC_NAME` is set, the build will pin signing to that Keychain certificate.
   - If `CSC_NAME` is not set, the build will auto-discover a valid certificate from Keychain.
   - If no distribution certificate is installed, the build can still continue with ad-hoc signing.
   - The `APPLE_*` variables in `.env` are used for notarization.

The `.env` file is already in `.gitignore` and will not be committed.

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
