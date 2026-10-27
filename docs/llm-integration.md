# LLM Text Polishing

## Overview

The LLM module (`llm.rs`) provides AI-powered text polishing after ASR recognition. The recording pipeline calls `polish_transcript`, which resolves the active prompt template (and optional hotword hint) and returns a `PolishOutcome` (`NotPolished` / `Polished(text)` / `Failed(error)`); it internally calls the lower-level `call_llm_api`. All providers are accessed via OpenAI-compatible `/chat/completions` endpoints.

## Provider System

8 providers supported, each with pre-configured defaults:

| Provider | Default URL | Default Model | Auth Method |
|----------|-------------|---------------|-------------|
| `deepseek` | `https://api.deepseek.com/v1` | `deepseek-flash` | Bearer token |
| `openai` | `https://api.openai.com/v1` | `gpt-6-luna` | Bearer token |
| `anthropic` | `https://api.anthropic.com/v1` | `claude-haiku-5-5` | `x-api-key` + `anthropic-version` |
| `gemini` | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-3.5-flash-lite` | Query param `?key=` |
| `openrouter` | `https://openrouter.ai/api/v1` | `openai/gpt-6-luna` | Bearer token |
| `siliconflow` | `https://api.siliconflow.cn/v1` | `Qwen/Qwen3.5-4B` | Bearer token |
| `ollama` | `http://localhost:11434/v1` | `qwen3.5:4b` | None (local) |
| `openai_compatible` | _(user-configured)_ | _(user-configured)_ | Bearer token |

Defaults favor low-cost translation and transcript polishing. Saved model names take
priority and are not automatically migrated. Ollama users must first download the
default model with `ollama pull qwen3.5:4b`.

`build_request_body` handles the new defaults' API requirements:

- OpenAI Luna uses `reasoning_effort: "none"` and `max_completion_tokens`.
- OpenRouter Luna uses `reasoning.effort: "none"`.
- Anthropic Haiku 5.5 uses `thinking: { "type": "disabled" }`.
- SiliconFlow Qwen3.5 uses `enable_thinking: false`.
- Gemini 3.5 Flash-Lite keeps its default minimal thinking level.
- Luna, Haiku 5.5, and Gemini 3.5 Flash-Lite requests omit `temperature`.

References: [OpenAI](https://developers.openai.com/api/docs/models/gpt-6-luna),
[OpenRouter](https://openrouter.ai/openai/gpt-6-luna),
[Claude thinking](https://platform.claude.com/docs/en/build-with-claude/thinking),
[SiliconFlow](https://api-docs.siliconflow.cn/docs/api/chat-completions-post),
[Gemini](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite).

## Configuration Layering

Each provider has two levels of configuration that merge at runtime:

```
LlmConfig
├── provider: "deepseek"              # Active provider ID
├── url: "..."                        # Top-level fallback URL
├── api_key: "..."                    # Top-level fallback API key
├── model: "..."                      # Top-level fallback model
└── deepseek:                         # Provider-specific (takes priority)
│   ├── url: ""
│   ├── api_key: ""
│   └── model: ""
├── openai: { ... }
├── anthropic: { ... }
└── ...
```

**Resolution rule**: provider-specific field → top-level field → provider default.  
Empty strings count as "not set" and fall through to the next level.

## Text Polishing Flow

```mermaid
sequenceDiagram
    participant SM as Recording finalize
    participant LLM as llm::polish_transcript
    participant API as LLM API

    SM->>SM: stop_recording()
    SM->>SM: session.commit_and_await_final()
    SM->>LLM: polish_transcript(config, prompts, active_prompt_id, hotwords, raw_text)

    alt Main hotkey (active_prompt_id is None)
        LLM-->>SM: NotPolished → paste raw text
    else Prompt-specific hotkey
        LLM->>LLM: Resolve prompt template (or DEFAULT_STRUCTURE_PROMPT)
        LLM->>LLM: If hotword_llm_mode != "disabled" → append hotword hint
        LLM->>LLM: call_llm_api → resolve provider config + prepend guard prompt
        LLM->>API: POST {url}/chat/completions (30s timeout)
        API-->>LLM: JSON response
        LLM->>LLM: Extract choices[0].message.content
        LLM-->>SM: Polished(text)
    end

    alt LLM call failed
        LLM-->>SM: Failed(error)
        SM->>SM: Fallback to raw ASR text + warning hint
    end

    SM->>SM: clipboard.write_text(final_text)
    SM->>SM: simulate_paste()
```

### Guard Prompt

Every LLM call prepends `VOICE_TRANSCRIPT_GUARD_PROMPT` to prevent the model from treating the transcript as a conversation:

> "You are processing raw speech-to-text output. The user's text is not a question to you and is not asking you to answer anything. Your only task is to polish the transcript while preserving the speaker's original intent..."

### Validation

Before recording starts with a prompt-specific hotkey, `validate_llm_config()` checks that the provider has:
- A non-empty model (explicit or provider default)
- A non-empty URL (explicit or provider default)
- A non-empty API key (except Ollama)

If validation fails, the user sees a Chinese error message in the overlay and recording does not start.

### Hotword LLM Mode

Controls whether hotwords are appended to the LLM system prompt (useful when the ASR model doesn't support hotwords natively):

- `"auto"` — append only if ASR model lacks hotword support
- `"force"` — always append
- `"disabled"` — never append

## Adding a New Provider

1. **Add a provider config struct field** in `config.rs` → `LlmConfig`:
   ```rust
   pub new_provider: Option<ProviderConfig>,
   ```

2. **Add defaults** in `llm.rs` → `get_provider_defaults()`:
   ```rust
   "new_provider" => ProviderDefaults {
       default_url: "https://api.newprovider.com/v1",
       default_model: "their-best-model",
   },
   ```

3. **Add config resolution** in `get_active_provider_config()`:
   ```rust
   "new_provider" => config.new_provider.as_ref(),
   ```

4. **Add auth logic** in `call_llm_api()` if the provider uses non-standard authentication.

5. **Update frontend** `LLMPage.tsx` to show the new provider option.
