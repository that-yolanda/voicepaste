# Configuration System

## ConfigManager Design

```
┌─────────────────────────────────────────────┐
│               ConfigManager                  │
│  ┌───────────────────────────────────────┐  │
│  │  RwLock<AppConfig>  (memory cache)    │  │
│  └───────────────────────────────────────┘  │
│                                              │
│  load_config() → copy from disk if stale    │
│  save_config() → write YAML, then re-read   │
│  reset_to_defaults() → copy from example    │
│  get_editable_config() → fresh disk read    │
└──────────────────┬──────────────────────────┘
                   │ reads/writes
                   ▼
┌─────────────────────────────────────────────┐
│  {app_data_dir}/                             │
│  ├── config.yaml        (runtime config)     │
│  ├── prompts.json       (prompt templates)   │
│  ├── hotwords.json      (hotword library)    │
│  └── registry.json      (model registry)     │
└─────────────────────────────────────────────┘
                   │ bundled as resources
                   ▼
┌─────────────────────────────────────────────┐
│  {resource_dir}/                             │
│  ├── config.yaml.example  (default template) │
│  ├── prompts.json         (default prompts)  │
│  ├── hotwords.json        (default hotwords) │
│  └── registry.json        (model registry)   │
└─────────────────────────────────────────────┘
```

**Key behaviors:**
- On first run, copies example files from resource dir to app data dir
- `save_config()` writes then re-reads from disk — avoids YAML-to-JSON round-trip precision loss
- `get_editable_config()` bypasses the cache, reading fresh from disk for the settings UI
- Hot-reload: saving config emits `overlay:event` (appearance) + `settings:event` (theme-changed)

## Default Value Resolution

All ASR parameters are resolved through a **3-layer merge chain**, with `registry.json` as the single source of truth for defaults.

### Merge Order

For every engine (doubao, sherpa-onnx, VAD), the effective configuration is determined by shallow-merging three layers:

```
Layer 1: registry.json → defaults.asr           ← shared defaults (rate, channel, vad, …)
    ↓
Layer 2: registry.json → <model>.default_config  ← model-specific defaults (url, model_name, …)
    ↓
Layer 3: config.yaml → audio.<model_id>          ← user overrides (only what user changed)
    ↓
Effective Config
```

Layer 3 wins over Layer 2, which wins over Layer 1. Keys not present in a higher layer fall through to the layer below.

### `config.yaml` Role

`config.yaml` now serves as a **user override file** — it records only parameters the user has explicitly changed from defaults via the settings UI:

- If a model section (`audio.doubao-streaming`, `audio.sherpa-onnx-*`, etc.) does not exist in `config.yaml`, all parameters use registry defaults.
- If a model section exists but only contains certain keys (e.g., just `app_id` + `access_token`), those keys override the registry defaults; all other keys still fall through to registry.
- The `audio.asr_defaults` section can override shared defaults for all models (e.g., VAD thresholds, num_threads).

### Registry Structure

```json
{
  "version": 13,
  "defaults": {
    "asr": { "rate": 16000, "channel": 1, … },    // shared across all ASR models
    "vad": { "threshold": 0.5, … }                 // VAD-specific shared defaults
  },
  "models": [
    {
      "id": "doubao-streaming",
      "default_config": { "url": "wss://…", "show_utterances": true, … }
    },
    {
      "id": "silero-vad",
      "default_config": { "threshold": 0.5, … }
    }
  ]
}
```

### Fallback When Registry Is Missing

If `registry.json` is corrupted or missing, the `ModelRegistry` falls back to the compile-time embedded version (`EMBEDDED_REGISTRY`). As a last resort, `DoubaoStreamingConfig` and `AsrDefaults` have Rust-level serde defaults that match the registry values.

### Adding a New Parameter

To add a new config parameter (e.g., `enable_new_feature`):

1. **`registry.json`**: Add the default value to `defaults.asr` (if shared across models) or to the specific model's `default_config` (if model-specific).
2. **`web/src/lib/model.ts`**: Add an entry to `FIELD_META` with the field label, control type, and options.
3. **`web/src/types/models.ts`**: Update TypeScript types if needed.
4. **Rust consumer** (if the parameter is used by the backend): Read the value from the merged config JSON:
   - For doubao: add the field to `RequestConfig` / `DoubaoStreamingConfig`.
   - For sherpa-onnx: add a `json_*()` call in the model-specific builder (e.g., `online.rs`, `sense_voice.rs`).
5. **`docs/configuration.md`**: Update this document.

No need to update `config.yaml.example` — it only shows the file structure, not individual parameter defaults.

## config.yaml Structure

Three top-level sections:

### app — Application Settings

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `hotkey` | string/array | `"F13"` | Global hotkey binding |
| `hotkey_mode` | string | `"toggle"` | `"toggle"` or `"hold"` |
| `remove_trailing_period` | bool | `true` | Strip trailing period from ASR output |
| `keep_clipboard` | bool | `true` | Keep text in clipboard after paste |
| `theme` | string | `"system"` | `"dark"` / `"light"` / `"system"` |
| `overlay_style` | string | `"liquid"` | macOS overlay appearance (3 variants) |
| `sound.enabled` | bool | `true` | Enable start/end sounds |
| `sound.start_sound` | string | `""` | Path to custom start sound |
| `sound.end_sound` | string | `""` | Path to custom end sound |
| `beta_updates` | bool | `false` | Enable beta update channel |

### audio — ASR Configuration

`config.yaml` only records user overrides — all default values come from `registry.json`. See [Default Value Resolution](#default-value-resolution) above.

| Field | Type | Default Source | Description |
|-------|------|----------------|-------------|
| `provider` | string | — | Active ASR model ID (e.g. `doubao-streaming`, `sherpa-onnx-streaming-zipformer-zh-en`) |
| `asr_defaults` | object | `registry.json → defaults.asr` | User overrides for shared defaults (rate, channel, num_threads, vad, provider, etc.) |
| `doubao-streaming` | object | `registry.json → doubao-streaming.default_config` | Doubao credentials + parameter overrides (url, app_id, show_utterances, etc.) |
| `<model-id>` | object | `registry.json → <model>.default_config` | Per-model overrides for any registered model |

Per-model configs are keyed by model ID (matching `registry.json`). Each model can override any field from its `default_config`.

### llm — LLM Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `provider` | string | `"deepseek"` | Active provider |
| `url` | string | `""` | Top-level fallback URL |
| `api_key` | string | `""` | Top-level fallback API key |
| `model` | string | `""` | Top-level fallback model |
| `<provider>` | object | — | Provider-specific overrides (deepseek, openai, anthropic, gemini, openrouter, siliconflow, ollama, openai_compatible) |

Configuration layering: provider-specific fields override top-level fields. See [llm-integration.md](llm-integration.md) for details.

## ModelRegistry (`registry.json`)

The model registry declares all available models (ASR, VAD, punctuation) with their capabilities, download URLs, and configuration schemas.

### ModelEntry Structure

```
ModelEntry
├── id: "model-unique-id"
├── type: "online" | "offline"
├── category: "asr" | "vad" | "punctuation"
├── engine: "volcengine" | "sherpa-onnx"
├── name: "Display Name"
├── description: "..."
├── tags: ["tag1", "tag2"]
├── capabilities:
│   ├── streaming: bool
│   ├── hotwords: bool
│   ├── punctuation: bool
│   └── itn: bool
├── languages: ["zh", "en"]
├── [online only] requires_config: ["url", "app_id", ...]
├── [offline only] architecture: "transducer" | "sense_voice" | ...
├── [offline only] download_url: "https://..."
├── [offline only] file_size: 100 (MB)
├── [offline only] mem_size: 200 (MB)
├── [offline only] model_files: { "model": "model.onnx", ... }
└── [offline only] default_config: { "num_threads": 4, ... }
```

### Model Resolution

When `audio.provider` is set to a model ID, the engine:
1. Loads `registry.json`
2. Finds the entry matching the ID
3. Reads `entry.engine` to choose Doubao vs. sherpa-onnx
4. For sherpa-onnx: reads `entry.architecture` and `entry.capabilities.streaming` to dispatch to the correct recognizer builder

### Model Download

Offline models are downloaded to `{app_data_dir}/models/<model-id>/`. The download flow:
1. Frontend calls `downloadModel(id)` → backend streams from `download_url`
2. Progress events emitted on `model:download:progress` channel
3. Downloaded archive (tar.bz2) is extracted to the model directory
4. `getDownloadedModels()` checks which registry entries have corresponding directories

## Hotwords (`hotwords.json`)

Grouped keyword library for improving ASR accuracy on domain-specific terms:

```json
{
  "groups": [
    {
      "id": "group-id",
      "name": "Group Name",
      "words": ["keyword1", "keyword2"],
      "enabled": true
    }
  ]
}
```

- Groups can be toggled on/off individually
- Active hotwords (from enabled groups) are passed to `AsrEngine::create_session()`
- The `HotwordManager` handles import from legacy Doubao config format

## Prompts (`prompts.json`)

LLM prompt templates for text polishing:

```json
[
  {
    "id": "prompt-id",
    "name": "Prompt Name",
    "prompt": "System prompt text...",
    "hotkey": "F14",
    "hotkey_mode": "hold"
  }
]
```

- Each prompt can have its own hotkey and mode
- Prompts with hotkeys trigger recording with LLM polishing
- Main hotkey (no prompt) bypasses LLM

## Configuration Flow

```mermaid
sequenceDiagram
    participant User
    participant FE as Settings UI
    participant BE as Backend
    participant Disk as Filesystem

    User->>FE: Open settings
    FE->>BE: get_settings_data()
    BE->>Disk: Read config.yaml + registry.json + hotwords.json + prompts.json
    Disk-->>BE: Raw data
    BE-->>FE: SettingsData (config + runtime + parsed)

    User->>FE: Edit + save
    FE->>BE: save_config_object({ audio: { provider: "..." } })
    BE->>Disk: Write config.yaml
    BE->>Disk: Re-read config.yaml (avoid round-trip loss)
    Disk-->>BE: Fresh config

    BE->>BE: reload_hotkey_bindings()
    BE->>FE: emit("overlay:event", { type: "appearance" })
    BE->>FE: emit("settings:event", { type: "theme-changed" })

    User->>User: Config takes effect immediately (hot-reload)
```
