# Development

## Run Locally

```bash
pnpm install
pnpm dev                # Run the full Tauri app
pnpm dev:web            # Run only the Vite dev server (frontend hot-reload)
```

## Build & Utilities

```bash
pnpm build:web          # Build frontend only (Vite → web/dist)
pnpm pack               # Build distributable packages
pnpm pack -s            # Build with macOS code signing and notarization
pnpm pack -p apple_aarch64          # macOS ARM64 only
pnpm pack -s -p apple_aarch64,win_x64  # Signed, specific platforms
pnpm clean              # Remove build artifacts and caches
```

## Lint & Format

```bash
pnpm lint               # Full-stack: biome lint + cargo clippy
pnpm format             # Full-stack: biome check --write + cargo fmt
pnpm check              # Full-stack: format + cargo clippy
pnpm lint:ci            # CI strict mode (read-only)
```

Pack platform keys: `apple_aarch64`, `apple_x64`, `win_x64`.

### Code Signing & Notarization (macOS)

Production builds with `-s` require code signing and notarization. Configure Apple credentials and the Tauri updater signing key in `.env` (see `.env.example`).

## Notes

- The project uses Tauri v2 with a React + TypeScript frontend, built by Vite, styled with Tailwind CSS.
- `config.yaml` is ignored and meant for local credentials.
- `config.yaml.example` is the shipped default template for packaged builds.
- Current supported desktop platforms are macOS and Windows.

## Testing

```bash
pnpm test             # Run all tests (vitest + cargo test)
pnpm test:watch       # Run frontend tests in watch mode
pnpm test:asr         # Run ASR integration tests (requires sherpa-onnx models)
pnpm test:llm         # Run LLM integration tests (requires API keys)
```

### Test Strategy

| Layer | Location | Trigger | Scope |
|-------|----------|---------|-------|
| **Rust unit tests** | Inline at bottom of each `.rs` file: `#[cfg(test)] mod tests { ... }` | `cargo test` | Pure logic — parsing, validation, serialization. Uses `tempfile` for file I/O isolation. No network, no models, no API keys. Runs in CI. |
| **Rust integration tests** | `src-tauri/src/tests/` (gated by Cargo features) | `pnpm test:asr` / `pnpm test:llm` | Requires external resources — sherpa-onnx model files (`asr-integration` feature) or LLM API keys (`llm-integration` feature). NOT run in CI. |
| **Frontend tests** | `web/tests/` (Vitest + jsdom) | `npx vitest run` | Component logic, pure functions. Tests organized by module (`bridge/`, `lib/`) with colocated mocks. |

### Rust Unit Test Conventions

- Follow the Rust official convention: unit tests live **inline** at the bottom of the same source file
- Structure: `#[cfg(test)] mod tests { use super::*; ... }`
- Pure logic functions (parsers, validators, serializers, normalizers) **must** have unit tests
- File I/O tests use `tempfile::tempdir()` for isolation (auto-cleanup)
- HTTP tests use `wiremock` to start a mock server and verify request/response
- Tests for complex types should include round-trip serialization checks

### Rust Integration Test Conventions

- Located in `src-tauri/src/tests/` with feature gates in `Cargo.toml`
- `asr-integration` feature: loads sherpa-onnx models and runs inference on audio fixtures
- `llm-integration` feature: makes real API calls with credentials from environment variables
- Both features are **opt-in** — default `cargo test` skips them entirely
- Integration tests access internal APIs via `use crate::...`
- Test audio fixtures live in `src-tauri/src/tests/fixtures/`
- ASR models are read from the app data directory (`~/Library/Application Support/com.yolanda.voicepaste/models/`) — tests never download models

### Test Requirements by Phase

| Phase | Requirement |
|-------|-------------|
| Core feature development | Unit tests for all pure logic functions |
| Cross-module features | Integration tests as needed (model inference, API calls) |
| Before code review | All unit tests pass (`cargo test`, `npx vitest run`) |
| Before release | All unit + integration tests pass (`pnpm test`, `pnpm test:asr`, `pnpm test:llm`) |

## Project Structure

```text
voicepaste/
├── assets/              # Source resource files (icons, sounds, tray icons)
│   ├── icon.png         #   Master app icon (source for `tauri icon`)
│   ├── sounds/          #   start.mp3, end.mp3
│   └── trayTemplate.png #   macOS tray icon source
├── scripts/             # Build and utility scripts (TypeScript)
│   ├── pack.ts          #   Main packaging script (-s, -p flags)
│   ├── clean.ts         #   Artifact cleanup
│   ├── prepare-assets.ts #  Pre-build asset generation (icons, tray)
│   └── validate-json.ts #   Schema validation for JSON configs
├── src-tauri/           # Rust backend (Tauri v2)
│   ├── src/
│   │   ├── lib.rs       #   App entry, state machine & hotkey management
│   │   ├── hotkey.rs    #   Global hotkey parsing & listener (keytap)
│   │   ├── asr/         #   ASR engine implementations
│   │   │   ├── doubao.rs            #   Doubao streaming ASR (WebSocket binary protocol)
│   │   │   └── sherpa_onnx/         #   Local ASR (sherpa-onnx) sub-modules
│   │   │       ├── mod.rs           #     SherpaOnnxEngine entry point + shared helpers
│   │   │       ├── online.rs        #     Streaming transducer + hotwords (hotwords_buf)
│   │   │       ├── offline.rs       #     Offline common flow + VAD segmentation
│   │   │       ├── sense_voice.rs   #     SenseVoice model config
│   │   │       ├── funasr_nano.rs   #     FunASR-Nano model config + hotwords
│   │   │       └── vad.rs           #     Silero VAD processor
│   │   ├── paste.rs     #   Clipboard write + simulated paste + sound
│   │   ├── config.rs    #   Config loading, prompts & YAML handling
│   │   ├── commands.rs  #   Tauri IPC command handlers
│   │   ├── updater.rs   #   Auto-update check & download/install
│   │   ├── llm.rs       #   LLM text polishing integration
│   │   ├── logger.rs    #   File logging
│   │   ├── stats.rs     #   Usage statistics & heatmap data
│   │   ├── app_state.rs #   Shared application state
│   │   ├── model.rs     #   Model registry
│   │   └── tests/       #   Integration tests (Cargo feature gated)
│   ├── icons/           #   App & tray icons (generated by `tauri icon`)
│   ├── capabilities/    #   Tauri permission capabilities
│   ├── Cargo.toml       #   Rust dependencies
│   └── tauri.conf.json  #   Tauri configuration
├── web/                 # Frontend (React + TypeScript + Vite + Tailwind)
│   ├── index.html       #   Floating overlay window
│   ├── settings.html    #   Settings page
│   ├── styles.css       #   Global styles with Tailwind directives
│   ├── src/
│   │   ├── bridge/      #     Tauri IPC bridge (settings, overlay)
│   │   ├── lib/         #     Pure utilities (audio, format, hotkey, model, sound)
│   │   ├── types/       #     TypeScript type definitions
│   │   ├── styles/      #     Shared CSS
│   │   └── ui/          #     React components
│   │       ├── components/ #   UI primitives (Button, Input, Toggle, Modal, etc.)
│   │       ├── layout/  #     PageLayout, Sidebar
│   │       └── pages/   #     Settings pages (AudioModel, Hotkey, LLM, etc.)
│   └── tests/           #   Frontend unit tests (Vitest, organized as bridge/ + lib/)
├── docs/                # Documentation, screenshots
├── build/               # Intermediate build artifacts (gitignored)
├── dist/                # Final distribution artifacts (gitignored)
├── config.yaml          # Local runtime config (gitignored)
├── config.yaml.example  # Shipped default config template
└── package.json
```

## Tech Stack

- **Frontend**: React 19, TypeScript, Vite, Tailwind CSS 4
- **Backend**: Tauri v2 (Rust)
- **ASR**: ByteDance Doubao streaming ASR over WebSocket (gzip-compressed binary framing), plus sherpa-onnx local models (SenseVoice, Zipformer, FunASR-Nano, Qwen3-ASR)
- **Lint & Format**: Biome (TS/TSX/JSON/CSS), cargo fmt + clippy (Rust)
- **Testing**: Vitest (frontend), cargo test (Rust)
- **Paste**: AppleScript on macOS, PowerShell on Windows
- **Hotkey**: `keytap` crate for global hotkey registration
- **Auto-update**: `tauri-plugin-updater` via GitHub Releases

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

## Logging Conventions

All logging uses the `log` crate with custom macros defined in `src-tauri/src/logger.rs`.

### Module Prefixes

| Macro | Module | Used in |
|-------|--------|---------|
| `log_app!` | App | lib.rs (init, config, sound) |
| `log_rec!` | Recording | lib.rs (recording state machine) |
| `log_asr!` | ASR | asr/ (doubao.rs, sherpa_onnx/) |
| `log_audio!` | Audio | commands.rs (audio chunks) |
| `log_hotkey!` | Hotkey | hotkey.rs |
| `log_events!` | Events | lib.rs (event forwarding) |
| `log_tray!` | Tray | lib.rs (tray menu) |
| `log_update!` | Update | updater.rs |

### Level Guidelines

- **ERROR**: Failures that break functionality (connection lost, config corrupt)
- **WARN**: Degraded behavior with fallback (LLM failed → raw text, chunk dropped)
- **INFO**: Key milestones only (state change, connection event, text received count)
- **DEBUG**: Verbose details for development (payloads, paths, preview text)
- ASR recognition text: **never at INFO**, use `log_rec!(debug, "preview: {:?}", truncated)`
- Do not use `eprintln!` / `println!` — use `log_*!` macros exclusively

### Log File Rotation

- Location: `{app_data_dir}/voicepaste.log`
- Max size: 300KB
- Rotation: gzip-compressed to `voicepaste.log.gz`, keeps only 1 backup
- Only INFO and above written to file

## Update Channels

VoicePaste uses two update channels (stable and beta) served from the same GitHub repository. The key constraint is that **GitHub's `/releases/latest/` URL only resolves to the latest non-prerelease release** — there is no static URL for prerelease releases.

### How It Works

Both `latest.json` (stable) and `latest-beta.json` (beta) are uploaded to the **stable release**. Each JSON uses Tauri's multi-platform `platforms` map — the beta JSON's platform entries point to download assets in the prerelease release.

```
Stable Release (v1.3.0)                      Beta Release (v1.3.1-beta, --prerelease)
├── latest.json (stable, multi-platform)      ├── VoicePaste_1.3.1-beta_aarch64.app.tar.gz
├── latest-beta.json (beta, multi-platform)   └── VoicePaste_1.3.1-beta_aarch64.app.tar.gz.sig
├── VoicePaste_1.3.0_aarch64.dmg
└── ...
```

### Release Workflow

1. **Stable release**: `gh release create v1.3.0 --latest`, upload stable artifacts + `latest.json`
2. **Beta release**: `gh release create v1.3.1-beta --prerelease`, upload beta artifacts. Then upload `latest-beta.json` to the latest stable release: `gh release upload v1.3.0 latest-beta.json --clobber`
3. **Beta → Stable**: Create a new stable release (e.g., `v1.3.1`). The new release becomes `/releases/latest/`, and the old beta metadata is no longer reachable.

### Why This Approach

- Tauri has no native multi-channel updater support
- GitHub has no static URL for "latest prerelease"
- `--prerelease` protects the Electron version on `main` branch
- SemVer guarantees `1.3.1-beta < 1.3.1` — stable users never see beta updates
