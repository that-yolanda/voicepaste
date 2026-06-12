# 开发说明

## 本地运行

```bash
pnpm install
pnpm dev
```

## 打包

```bash
pnpm build              # 生产构建（tauri build）
pnpm pack               # 构建分发安装包
pnpm pack -s            # 构建 + macOS 签名与公证
pnpm pack -p apple_aarch64          # 仅 macOS ARM64
pnpm pack -s -p apple_aarch64,win_x64  # 签名 + 指定平台
pnpm clean              # 清理构建产物与缓存
```

打包平台参数：`apple_aarch64`、`apple_x64`、`win_x64`。

### 代码签名与公证（macOS）

使用 `-s` 参数的生产构建需要配置代码签名和公证。在 `.env` 中配置 Apple 凭证和 Tauri 更新签名密钥（参考 `.env.example`）。

## 说明

- 项目基于 Tauri v2，前端使用原生 JS（无框架、无打包器）。
- `config.yaml` 已加入忽略，用于本地填写真实凭证。
- `config.yaml.example` 是打包产物默认携带的模板配置。
- 当前桌面平台支持 macOS 和 Windows。

## 测试

```bash
pnpm test             # 运行所有测试（Rust + 前端）
pnpm test:rust        # 仅运行 Rust 单元测试
pnpm test:asr         # 运行 ASR 集成测试（需已下载 sherpa-onnx 模型）
pnpm test:llm         # 运行 LLM 集成测试（需配置 API Key）
pnpm test:frontend    # 仅运行前端单元测试
pnpm test:watch       # 监听模式运行前端测试
```

### 测试策略

| 层级 | 位置 | 运行方式 | 说明 |
|------|------|---------|------|
| **Rust 单元测试** | 各 `.rs` 文件底部 `#[cfg(test)] mod tests { ... }` | `pnpm test:rust` | 纯逻辑函数测试（解析、校验、序列化等）。使用 `tempfile` 隔离文件 I/O，不涉及网络/模型/API Key。在 CI 中运行。 |
| **Rust 集成测试** | `src-tauri/src/tests/`，通过 Cargo features 控制 | `pnpm test:asr` / `pnpm test:llm` | 需外部资源：sherpa-onnx 模型文件（`asr-integration` feature）或 LLM API Key（`llm-integration` feature）。不在 CI 中运行。 |
| **前端测试** | `web/tests/`（Vitest + jsdom） | `pnpm test:frontend` | 组件逻辑、纯函数测试。通过 `web/tests/helpers/` 模拟 `window.__TAURI__` 和 Web API。 |

### Rust 单元测试规范

- 遵循 Rust 官方惯例：单元测试**内联**写在源文件底部
- 结构：`#[cfg(test)] mod tests { use super::*; ... }`
- 纯逻辑函数（解析器、校验器、序列化器、规范化器）**必须**编写单元测试
- 文件 I/O 测试使用 `tempfile::tempdir()` 隔离，自动清理
- HTTP 测试使用 `wiremock` 启动模拟服务器验证请求/响应
- 复杂类型应包含序列化往返测试

### Rust 集成测试规范

- 位于 `src-tauri/src/tests/`，通过 `Cargo.toml` 中的 features 控制编译
- `asr-integration`：加载 sherpa-onnx 模型，对测试音频进行推理
- `llm-integration`：通过环境变量获取凭证，调用真实 LLM API
- 两个 feature 默认关闭，`cargo test` 不会运行集成测试
- 集成测试通过 `use crate::...` 访问内部 API
- 测试音频文件放在 `src-tauri/src/tests/fixtures/`
- ASR 模型从应用数据目录读取（`~/Library/Application Support/com.yolanda.voicepaste/models/`），不会自动下载

### 各阶段测试要求

| 阶段 | 要求 |
|------|------|
| 核心功能开发 | 所有纯逻辑函数必须有单元测试 |
| 跨模块功能 | 按需编写集成测试（模型推理、API 调用等） |
| 代码审查前 | 所有单元测试通过（`pnpm test:rust`、`pnpm test:frontend`） |
| 发布前 | 所有单元测试 + 集成测试通过（`pnpm test`、`pnpm test:asr`、`pnpm test:llm`） |

## 项目结构

```text
voicepaste/
├── assets/              # 源资源文件（图标、音频、托盘图标）
│   ├── icon.png         #   主应用图标（`tauri icon` 的源文件）
│   ├── sounds/          #   start.mp3、end.mp3
│   └── trayTemplate.png #   macOS 托盘图标源文件
├── scripts/             # 构建与工具脚本
│   ├── pack.js          #   主打包脚本（-s、-p 参数）
│   ├── clean.js         #   产物清理
│   └── extract-icons.js #   Lucide 图标提取（beforeBuildCommand）
├── src-tauri/           # Rust 后端（Tauri v2）
│   ├── src/
│   │   ├── lib.rs       #   应用入口、状态机与快捷键管理
│   │   ├── hotkey.rs    #   全局快捷键解析与监听（keytap）
│   │   ├── asr/         #   ASR 引擎实现
│   │   │   ├── doubao.rs      #   豆包流式 ASR（WebSocket 二进制协议）
│   │   │   ├── sherpa_onnx.rs #   Sherpa-ONNX 离线识别（FunASR-Nano 等）
│   │   │   └── vad.rs         #   VAD 配置（Silero VAD）
│   │   ├── paste.rs     #   剪贴板写入、模拟粘贴与音效播放
│   │   ├── config.rs    #   配置加载、模板与 YAML 处理
│   │   ├── commands.rs  #   Tauri IPC 命令处理
│   │   ├── updater.rs   #   自动更新检查与下载安装
│   │   ├── llm.rs       #   LLM 文本润色集成
│   │   ├── logger.rs    #   文件日志
│   │   ├── stats.rs     #   使用统计与热力图数据
│   │   ├── app_state.rs #   共享应用状态
│   │   ├── model.rs     #   模型注册表
│   │   └── tests/       #   集成测试（Cargo feature gated）
│   ├── icons/           #   应用与托盘图标（`tauri icon` 生成）
│   ├── capabilities/    #   Tauri 权限配置
│   ├── Cargo.toml       #   Rust 依赖
│   └── tauri.conf.json  #   Tauri 配置
├── web/                 # 前端（WebView）
│   ├── index.html       #   浮动覆盖窗口
│   ├── app.js           #   音频采集与文本显示
│   ├── settings.html    #   设置页面
│   ├── settings.js      #   配置编辑器、更新 UI 与逻辑
│   ├── settings.css     #   样式与主题变量
│   ├── theme.css        #   亮/暗主题定义
│   ├── tauri-bridge.js  #   IPC 桥接（替代 Electron preload）
│   ├── lucide-icons.js  #   SVG 图标定义（自动生成）
│   └── tests/           #   前端单元测试（Vitest）
├── docs/                #   文档、截图
├── build/               #   中间构建产物（gitignore）
├── dist/                #   最终分发产物（gitignore）
├── config.yaml          #   本地运行配置（gitignore）
├── config.yaml.example  #   打包默认模板配置
└── package.json
```

## 技术栈

- Tauri v2（Rust 后端 + WebView 前端）
- 字节跳动豆包 ASR（WebSocket）
- gzip 压缩二进制帧
- macOS 使用 AppleScript、Windows 使用 PowerShell 模拟粘贴
- `keytap` crate 注册全局快捷键
- `tauri-plugin-updater` 通过 GitHub Releases 实现自动更新

## 工作流程

```text
按下快捷键 → 开始录音 → 麦克风采集 PCM 音频 → 下采样到 16kHz
  → 通过 IPC 发送音频块 → WebSocket 转发到 ASR 服务
  → 流式返回识别结果 → 悬浮窗显示文本
再次按下（或 hold 模式松开）→ 等待最终结果 → 可选 LLM 润色 → 写入剪贴板 → 模拟粘贴
```

## 系统要求

- macOS 12+ / Windows 10+
- Rust（最新稳定版）
- pnpm
