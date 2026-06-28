# 开发说明

## 快速开始

```bash
pnpm install
pnpm dev                # 运行完整 Tauri 应用
pnpm dev:web            # 仅运行 Vite 开发服务器（前端热更新）
```

## 构建与工具

```bash
pnpm build:web          # 仅构建前端（Vite → web/dist）
pnpm pack               # 构建分发安装包
pnpm pack -s            # 构建 + macOS 签名与公证
pnpm pack -p apple_aarch64          # 仅 macOS ARM64
pnpm pack -s -p apple_aarch64,win_x64  # 签名 + 指定平台
pnpm clean              # 清理构建产物与缓存
```

打包平台参数：`apple_aarch64`、`apple_x64`、`win_x64`。

## 代码检查与格式化

```bash
pnpm lint               # 全栈：biome lint + cargo clippy
pnpm format             # 全栈：biome check --write + cargo fmt
pnpm check              # 全栈：format + cargo clippy
pnpm lint:ci            # CI 严格模式（只读）
```

## 模块索引

| 模块 | 文档 | 简介 |
|------|------|------|
| 架构与状态机 | [architecture.md](architecture.md) | 整体架构、录音状态机、数据流、窗口管理 |
| ASR 引擎系统 | [asr-engine.md](asr-engine.md) | Trait 设计、豆包 WebSocket 协议、sherpa-onnx 架构、VAD、新增模型 |
| 前端与 IPC | [frontend-ipc.md](frontend-ipc.md) | React 组件树、IPC 桥接、事件系统、音频采集、悬浮窗、粘贴 |
| 配置系统 | [configuration.md](configuration.md) | ConfigManager、config.yaml 结构、模型注册表、热词、提示词 |
| LLM 文本润色 | [llm-integration.md](llm-integration.md) | 8 家提供商系统、配置分层、润色流程 |
| 全局快捷键 | [hotkey-system.md](hotkey-system.md) | keytap 集成、Toggle/Hold 模式、提示词快捷键、前端录制 |
| 测试与发布 | [testing-and-release.md](testing-and-release.md) | 测试策略与规范、构建流水线、签名公证、更新渠道、发布流程 |

## 项目结构

```text
voicepaste/
├── assets/              # 源资源文件（图标、音频、托盘图标）
├── scripts/             # 构建与工具脚本（TypeScript）
│   ├── pack.ts          #   主打包脚本（-s、-p 参数）
│   ├── clean.ts         #   产物清理
│   ├── prepare-assets.ts #  预构建资源生成（图标、托盘）
│   └── validate-json.ts #   JSON 配置文件 schema 校验
├── src-tauri/           # Rust 后端（Tauri v2）
│   ├── src/
│   │   ├── lib.rs       #   应用入口、状态机与快捷键管理
│   │   ├── hotkey.rs    #   全局快捷键解析与监听（keytap）
│   │   ├── asr/         #   ASR 引擎实现
│   │   │   ├── mod.rs               #   AsrEngine / AsrSession / AsrEvent 特质
│   │   │   ├── doubao.rs            #   豆包流式 ASR（WebSocket 二进制协议）
│   │   │   └── sherpa_onnx/         #   离线 ASR（sherpa-onnx）
│   │   │       ├── mod.rs           #     SherpaOnnxEngine 入口 + 共享工具
│   │   │       ├── online.rs        #     Streaming transducer + 热词
│   │   │       ├── offline.rs       #     离线通用流程 + VAD 分段
│   │   │       ├── simulated_streaming.rs  #  离线模型模拟流式
│   │   │       ├── sense_voice.rs   #     SenseVoice 模型 config
│   │   │       ├── funasr_nano.rs   #     FunASR-Nano 模型 config + 热词
│   │   │       ├── qwen3_asr.rs     #     Qwen3-ASR 模型 config
│   │   │       ├── punct.rs         #     标点恢复
│   │   │       └── vad.rs           #     Silero VAD 处理器
│   │   ├── paste.rs     #   剪贴板写入、模拟粘贴与音效播放
│   │   ├── config.rs    #   配置加载、模板与 YAML 处理
│   │   ├── commands.rs  #   Tauri IPC 命令处理
│   │   ├── updater.rs   #   自动更新检查与下载安装
│   │   ├── llm.rs       #   LLM 文本润色集成
│   │   ├── logger.rs    #   文件日志
│   │   ├── stats.rs     #   使用统计与热力图数据
│   │   ├── app_state.rs #   共享应用状态
│   │   ├── model.rs     #   模型注册表
│   │   ├── overlay/     #   覆盖窗渲染器（mod.rs / shared.rs / macos.rs）
│   │   └── tests/       #   集成测试（Cargo feature gated）
│   ├── icons/           #   应用与托盘图标（`tauri icon` 生成）
│   ├── capabilities/    #   Tauri 权限配置
│   ├── Cargo.toml       #   Rust 依赖
│   └── tauri.conf.json  #   Tauri 配置
├── web/                 # 前端（React + TypeScript + Vite + Tailwind）
│   ├── index.html       #   浮动覆盖窗口入口（仅 Windows）
│   ├── settings.html    #   设置页面入口
│   ├── src/
│   │   ├── overlay/     #     覆盖窗 React 应用（index.tsx + 状态/布局 hooks）
│   │   ├── settings/    #     设置 React 应用（components/、pages/、lib/、types/）
│   │   └── styles/      #     共享 CSS（app.css）
│   └── tests/           #   前端单元测试（Vitest，按 bridge/ + lib/ 组织）
├── schemas/             #   JSON Schema 文件（hotwords, prompts, registry）
├── docs/                #   文档
├── build/               #   中间构建产物（gitignore）
├── dist/                #   最终分发产物（gitignore）
├── config.yaml          #   本地运行配置（gitignore，填写真实凭证）
├── config.yaml.example  #   打包默认模板配置（空凭证）
└── package.json
```

## 技术栈

- **前端**：React 19、TypeScript、Vite、Tailwind CSS 4
- **后端**：Tauri v2（Rust）
- **ASR**：字节跳动豆包流式 ASR（WebSocket + gzip 压缩二进制帧），以及 sherpa-onnx 本地模型（SenseVoice、Zipformer、FunASR-Nano、Qwen3-ASR）
- **代码检查**：Biome（TS/TSX/JSON/CSS）、cargo fmt + clippy（Rust）
- **测试**：Vitest（前端）、cargo test（Rust）
- **粘贴**：macOS 使用 AppleScript、Windows 使用 PowerShell
- **快捷键**：`keytap` crate 注册全局快捷键
- **自动更新**：`tauri-plugin-updater` 通过 GitHub Releases

## 系统要求

- macOS 12+ / Windows 10+
- Rust（最新稳定版）
- pnpm

## 日志规范

所有日志使用 `log` crate 的自定义宏，定义在 `src-tauri/src/logger.rs`。

### 模块前缀

| 宏 | 模块 | 使用位置 |
|-----|------|---------|
| `log_app!` | App | lib.rs（初始化、配置、音效） |
| `log_rec!` | Recording | lib.rs（录音状态机） |
| `log_asr!` | ASR | asr/（doubao.rs、sherpa_onnx/） |
| `log_audio!` | Audio | commands.rs（音频块） |
| `log_hotkey!` | Hotkey | hotkey.rs |
| `log_events!` | Events | lib.rs（事件转发） |
| `log_tray!` | Tray | lib.rs（托盘菜单） |
| `log_update!` | Update | updater.rs |

### 级别指南

- **ERROR**：导致功能中断的故障（连接丢失、配置损坏）
- **WARN**：有降级方案的异常行为（LLM 失败→原文、音频块丢弃）
- **INFO**：仅关键节点（状态变更、连接事件、文本数量统计）
- **DEBUG**：开发用详细信息（负载、路径、文本预览）
- ASR 识别文本：**绝不在 INFO 级别输出**，使用 `log_rec!(debug, "preview: {:?}", truncated)`
- 禁止使用 `eprintln!` / `println!`，只能使用 `log_*!` 宏

### 日志文件轮转

- 位置：`{app_data_dir}/voicepaste.log`
- 最大大小：300KB
- 轮转：gzip 压缩为 `voicepaste.log.gz`，仅保留 1 个备份
- 仅 INFO 及以上级别写入文件
