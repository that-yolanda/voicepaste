# VoicePaste

> A voice input tool for macOS & Windows — press a hotkey, speak, auto-paste.

**[中文](README.zh.md)**

## Features

- **Global Hotkey** — Default `Control+Space` from `config.yaml.example`, supports custom key recording
- **Real-time ASR** — ByteDance Doubao streaming ASR via WebSocket
- **Auto Paste** — Automatically pastes recognized text into the focused input field
- **Floating Overlay** — Transparent overlay window showing real-time transcription
- **Clipboard Options** — Can keep the recognized text in the clipboard for manual re-paste
- **Text Cleanup** — Can automatically remove trailing `。` / `.`
- **Auto Start** — Optional launch at login from the settings page
- **Hotwords** — Custom hotwords to improve recognition accuracy for domain-specific terms
- **Cross-platform** — Supports both macOS and Windows
- **Theme** — Light / dark / system theme preference in settings

## Preview

**Voice Input**

![VoicePaste Demo](docs/screenshots/demo.gif)

**Settings Page**

![VoicePaste Settings](docs/screenshots/config.png)

---

## Getting API Credentials

- Log in to the [Volcengine Console](https://console.volcengine.com/speech/app), create an app, and select "Doubao Streaming ASR Model 2.0 (Hourly)"

![Create App](docs/screenshots/api-step1.png)

- Open the model, select your app, and enable the model package. You'll see the APP ID, Access Token, and Secret Key below

![Get Credentials](docs/screenshots/api-step2.png)

- Enter the credentials in the settings page and click Save

![Save Config](docs/screenshots/api-step3.png)

## Configuration

Edit `config.yaml` in the project root and fill in your credentials:

| Field | Description |
|-------|-------------|
| `app.hotkey` | Global hotkey. Default template value is `Control+Space` |
| `app.remove_trailing_period` | Remove trailing `。` / `.` from the final text |
| `app.keep_clipboard` | Keep the result in the clipboard after paste |
| `app.theme` | Theme preference: `dark` / `light` / `system` |
| `connection.app_id` | Volcengine App ID |
| `connection.access_token` | Volcengine Access Token |
| `connection.secret_key` | Volcengine Secret Key |
| `connection.resource_id` | ASR Resource ID |
| `request.context_hotwords` | Custom hotwords list |

Get your credentials from [Volcengine Voice Service](https://www.volcengine.com/product/voice-service).

Note: packaged builds ship `config.yaml.example` as the default config template, so the effective default hotkey is `Control+Space`. The code-level fallback `F13` is only used when `app.hotkey` is missing.

## FAQ

### VoicePaste doesn't work on macOS?

VoicePaste requires **Microphone** and **Accessibility** permissions to function properly.

**Microphone Permission**

1. Settings page → System Permissions → Click "Request Permission"
2. System Settings → Privacy & Security → Microphone, make sure VoicePaste is authorized
3. If previously denied, reset via Terminal and re-authorize:
```bash
tccutil reset Microphone com.yolanda.voicepaste
```

**Accessibility Permission**

1. System Settings → Privacy & Security → Accessibility, make sure VoicePaste is authorized
2. If reinstalled after deletion, you need to add it again

### Hotwords work during streaming but are wrong in the final result with non-stream enabled?

The non-stream (second-pass) recognition mode does not currently support hotword libraries or injected hotwords — only correction tables are supported. Create a [correction table](https://console.volcengine.com/speech/correctword) in the Volcengine console and replace `boosting_table_id` with `correct_table_id` in your config.

## Docs

- [Development Guide](docs/development.md)
- [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE)
