# 开发说明

## 本地运行

```bash
pnpm install
pnpm dev
```

## 打包

```bash
pnpm build              # 生产构建（tauri build）
```

### 代码签名与公证（macOS）

生产构建需要配置代码签名和公证。通过 `tauri.conf.json` 的 bundle 设置和环境变量进行配置。

## 说明

- 项目基于 Tauri v2，前端使用原生 JS（无框架、无打包器）。
- `config.yaml` 已加入忽略，用于本地填写真实凭证。
- `config.yaml.example` 是打包产物默认携带的模板配置。
- 当前桌面平台支持 macOS 和 Windows。

## 项目结构

```text
voicepaste/
├── src-tauri/            # Rust 后端（Tauri v2）
│   ├── src/
│   │   ├── lib.rs        # 应用入口、状态机与快捷键管理
│   │   ├── asr.rs        # WebSocket ASR 客户端（二进制协议）
│   │   ├── paste.rs      # 剪贴板写入、模拟粘贴与音效播放
│   │   ├── config.rs     # 配置加载、模板与 YAML 处理
│   │   ├── commands.rs   # Tauri IPC 命令处理
│   │   ├── llm.rs        # LLM 文本润色集成
│   │   ├── logger.rs     # 文件日志
│   │   ├── stats.rs      # 使用统计与热力图数据
│   │   └── app_state.rs  # 共享应用状态
│   ├── icons/            # 应用图标与托盘图标（icns, ico, png）
│   ├── capabilities/     # Tauri 权限配置
│   ├── Cargo.toml        # Rust 依赖
│   └── tauri.conf.json   # Tauri 配置
├── renderer/             # 前端（WebView）
│   ├── index.html        # 浮动覆盖窗口
│   ├── app.js            # 音频采集与文本显示
│   ├── settings.html     # 设置页面
│   ├── settings.js       # 配置编辑器与 UI 逻辑
│   ├── settings.css      # 样式与主题变量
│   ├── theme.css         # 亮/暗主题定义
│   ├── tauri-bridge.js   # IPC 桥接（替代 Electron preload）
│   └── lucide-icons.js   # SVG 图标定义
├── docs/                 # 文档、更新说明、截图
├── config.yaml           # 本地运行配置（已 gitignore）
├── config.yaml.example   # 打包默认模板配置
└── package.json
```

## 技术栈

- Tauri v2（Rust 后端 + WebView 前端）
- 字节跳动豆包 ASR（WebSocket）
- gzip 压缩二进制帧
- macOS 使用 AppleScript、Windows 使用 PowerShell 模拟粘贴
- tauri-plugin-global-shortcut 注册全局快捷键

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
