<div align="center">

![VoicePaste Demo](docs/screenshots/banner.png)

# VoicePaste

A voice input tool for macOS & Windows — trigger with a hotkey, speak, auto-paste.

[![Downloads](https://img.shields.io/github/downloads/that-yolanda/voicepaste/total?style=flat&logo=github)](https://github.com/that-yolanda/voicepaste/releases/latest)
[![Version](https://img.shields.io/github/v/release/that-yolanda/voicepaste?style=flat&logo=github)](https://github.com/that-yolanda/voicepaste/releases/latest)
[![License](https://img.shields.io/github/license/that-yolanda/voicepaste?style=flat&logo=github)](https://github.com/that-yolanda/voicepaste/blob/master/LICENSE)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-Buy%20me%20a%20coffee-ff5e5b?logo=ko-fi&logoColor=white)](https://ko-fi.com/thatyolanda)

**[中文](README.zh.md)** | **[English](README.md)**

</div>

## Demo

![VoicePaste Demo](docs/screenshots/demo.gif)

## Features

- **Lightweight**: ~20 MB installer; ~80 MB idle memory, ~100 MB with online API. Local models use on-demand loading — they only reside in memory during recognition and are released immediately after.
- **Data Security**: All data stored locally; API keys are applied by the user, giving you full control.
- **Fully Customizable**: Ready-to-use defaults with all parameters exposed for fine-tuning.
- **ASR Dual Engine (Online / Local)**: Online — ByteDance Doubao streaming ASR; Local — powered by sherpa-onnx, 500 MB+ memory footprint depending on model, with CPU / CUDA / CoreML acceleration.
- **LLM Support**: Built-in support for 8 LLM providers — DeepSeek, OpenAI, Anthropic, Gemini, OpenRouter, SiliconFlow, Ollama, and OpenAI-compatible APIs.
- **Streaming Output**: For local models without native streaming, VAD-based segmentation with simulated streaming output delivers results in real time.
- **Multi-Scenario Text Polishing**: Built-in templates for general cleanup, translation, email drafting, and more — customizable prompts with per-template hotkey bindings.
- **Hotwords**: Multi-group hotword libraries to boost domain-specific term accuracy; automatically restores original formatting (capitalization, special characters, etc.), no manual corrections needed.
- **Cross-Platform**: macOS (Apple Silicon / Intel) and Windows.
- **Customizable Hotkeys**: Bind independent hotkeys for different scenarios (general, translation, formatting, etc.) with support for `toggle` (press to start, press again to stop) and `hold` (hold to speak, release to stop) modes.
- **Enhanced Experience**: Audio feedback sounds, real-time waveform animation.
- **Apple Signed & Notarized**: macOS builds are signed and notarized with an Apple Developer certificate — no Gatekeeper warnings on install (Windows builds are currently unsigned).

## Quick Start

### Download

Go to [GitHub Releases](https://github.com/that-yolanda/voicepaste/releases/latest) and download the latest version for your platform.

| Platform               | Installer Filename                                |
| ---------------------- | ------------------------------------------------- |
| macOS (Apple Silicon)  | `VoicePaste_{version}_aarch64.dmg`                |
| macOS (Intel)          | `VoicePaste_{version}_x64.dmg`                    |
| Windows (x64)          | `VoicePaste_{version}_x64-setup.exe` / `.msi`     |

### Configuration Guide

| Type                          | Link                                                                  |
| ----------------------------- | --------------------------------------------------------------------- |
| General Setup                 | [EN](GUIDANCE.md#quick-start-minimal-setup) / [中文](GUIDANCE.zh.md#快速开始最小配置)  |
| Doubao Streaming ASR          | [EN](GUIDANCE.md#volcengine-doubao) / [中文](GUIDANCE.zh.md#火山引擎)          |
| Local Models                  | [EN](GUIDANCE.md#local-models) / [中文](GUIDANCE.zh.md#本地模型)|

## Model Support & Capabilities

### ASR Models

| Type   | Model                         | Guide                                                                 | Size    | Peak Memory | Languages                             | Streaming               | Hotwords                    | Punctuation                       | ITN                    | Model ID                                                   |
| ------ | ----------------------------- | --------------------------------------------------------------------- | ------- | ----------- | ------------------------------------- | ----------------------- | --------------------------- | --------------------------------- | ---------------------- | ---------------------------------------------------------- |
| Online | Doubao Streaming ASR 2.0      | [EN](docs/howto/doubao.md) / [中文](docs/howto/doubao.zh.md)          | -       | 120 MB      | Chinese + English mix, dialects       | ✅️                      | ✅️                          | ✅️                                | ✅️                     | -                                                          |
| Local  | SenseVoice                    | [EN](docs/howto/sherpa-onnx.md) / [中文](docs/howto/sherpa-onnx.zh.md)| 158 MB  | 660 MB      | ZH / EN / JP / KO / Cantonese         | ☑️ Simulated streaming   | ☑️ via LLM                  | ☑️ via punctuation model          | ☑️ via LLM             | sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09    |
| Local  | Zipformer (ZH + EN bilingual) | [EN](docs/howto/sherpa-onnx.md) / [中文](docs/howto/sherpa-onnx.zh.md)| 150 MB  | 560 MB      | Chinese + English                     | ✅️                      | ✅️                          | ☑️ via punctuation model          | ☑️ via LLM             | sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20 |
| Local  | FunASR-Nano                   | [EN](docs/howto/sherpa-onnx.md) / [中文](docs/howto/sherpa-onnx.zh.md)| 948 MB  | 1.8 GB      | Chinese + English, 7 dialects         | ☑️ Simulated streaming   | ✅️                          | ✅️                                | ✅️                     | sherpa-onnx-funasr-nano-int8-2025-12-30                    |
| Local  | Qwen3-ASR-0.6B                | [EN](docs/howto/sherpa-onnx.md) / [中文](docs/howto/sherpa-onnx.zh.md)| 938 MB  | 2.0 GB      | 30 languages, Chinese dialects, lyrics, rap | ☑️ Simulated streaming   | ✅️                          | ✅️                                | ✅️                     | sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25                 |

**Notes**

- ✅️ Native model capability, ☑️ Achieved through software composition
- Idle memory ~80 MB; models are loaded on demand during recognition and released after completion.
- Local models without native streaming output use built-in VAD (Voice Activity Detection) for audio segmentation with simulated streaming; optional punctuation restoration model available.
- Memory data measured on Mac mini (Apple Silicon).

### LLM

| Provider          | Supported |
| ----------------- | --------- |
| OpenAI            | ✅️        |
| DeepSeek          | ✅️        |
| Anthropic         | ✅️        |
| OpenRouter        | ✅️        |
| SiliconFlow       | ✅️        |
| Gemini            | ✅️        |
| Ollama            | ✅️        |
| OpenAI-Compatible | ✅️        |

## FAQ

### Not working on macOS?

VoicePaste requires **Microphone** and **Accessibility** permissions to function.

**Microphone Permission**

1. Settings page → System Permissions → Click "Request Permission"
2. System Settings → Privacy & Security → Microphone, ensure VoicePaste is authorized
3. If previously denied, reset via Terminal and re-authorize:

```bash
tccutil reset Microphone com.yolanda.voicepaste
```

**Accessibility Permission**

1. System Settings → Privacy & Security → Accessibility, ensure VoicePaste is authorized
2. If reinstalled after deletion, re-add it manually

## Docs

- [Development Guide](docs/development.md)
- [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE)
