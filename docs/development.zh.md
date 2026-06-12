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
pnpm test:rust        # 仅运行 Rust 单元/集成测试
pnpm test:frontend    # 仅运行前端单元测试
pnpm test:watch       # 监听模式运行前端测试
```

### 测试结构

- **Rust**：测试使用 `#[path = "tests/xxx.rs"]` 属性，文件放在 `src-tauri/src/asr/tests/` 下。通过 `cargo test` 运行。开发依赖包括 `tempfile`（隔离文件 I/O）和 `wiremock`（HTTP 模拟）。
- **前端**：Vitest + jsdom。测试文件在 `web/tests/` 下，辅助文件在 `web/tests/helpers/` 下。通过 helper 文件模拟 `window.__TAURI__`、`window.voiceOverlay`、`window.voiceSettings` 及 Web API。

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
│   │   ├── asr.rs       #   WebSocket ASR 客户端（二进制协议）
│   │   ├── paste.rs     #   剪贴板写入、模拟粘贴与音效播放
│   │   ├── config.rs    #   配置加载、模板与 YAML 处理
│   │   ├── commands.rs  #   Tauri IPC 命令处理
│   │   ├── updater.rs   #   自动更新检查与下载安装
│   │   ├── llm.rs       #   LLM 文本润色集成
│   │   ├── logger.rs    #   文件日志
│   │   ├── stats.rs     #   使用统计与热力图数据
│   │   ├── app_state.rs #   共享应用状态
│   │   └── tests/       #   单元与集成测试
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
