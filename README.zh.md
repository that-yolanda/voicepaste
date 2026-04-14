# VoicePaste

> macOS 语音输入工具 — 按下快捷键，说话，松开即粘贴。

**[English](README.md)**

## 功能特性

- **全局快捷键** — 默认 F13，可在 `config.yaml` 中自定义
- **实时语音识别** — 使用字节跳动豆包大模型 ASR，流式返回识别结果
- **自动粘贴** — 识别完成后自动将文本粘贴到当前输入位置
- **浮动窗口** — 透明悬浮窗实时显示识别进度
- **热词支持** — 可自定义热词提升专业术语识别准确率
- **系统托盘** — 后台运行，不占用 Dock 栏位置

## 效果预览

**语音输入**

![VoicePaste Demo](docs/demo.gif)

**配置页面**

![VoicePaste Settings](docs/config.png)

## 安装

### 从源码构建

```bash
# 克隆仓库
git clone https://github.com/that-yolanda/voicepaste.git
cd voicepaste

# 安装依赖
pnpm install

# 启动应用
pnpm start
```

### 打包

```bash
pnpm pack
```

打包产物位于 `dist/` 目录。

## 配置

编辑项目根目录下的 `config.yaml`，填入你的凭证：

| 配置项 | 说明 |
|--------|------|
| `app.hotkey` | 全局快捷键，默认 `F13` |
| `connection.app_id` | 火山引擎 App ID |
| `connection.access_token` | 火山引擎 Access Token |
| `connection.secret_key` | 火山引擎 Secret Key |
| `connection.resource_id` | ASR 资源 ID |
| `request.context_hotwords` | 自定义热词列表 |

凭证申请请参考 [字节跳动火山引擎语音服务](https://www.volcengine.com/product/voice-service)。

## 项目结构

```
voicepaste/
├── main/               # Electron 主进程
│   ├── main.js         # 应用入口，状态机与快捷键管理
│   ├── asrService.js   # WebSocket ASR 客户端（二进制协议）
│   ├── pasteService.js # 剪贴板写入 + AppleScript 粘贴
│   ├── windowManager.js# 窗口创建与管理
│   ├── config.js       # 配置文件加载与热重载
│   └── logger.js       # 日志模块
├── preload/            # Preload 脚本
│   └── preload.js      # contextBridge API
├── renderer/           # 渲染进程
│   ├── index.html      # 浮动覆盖窗口
│   ├── app.js          # 音频采集与文字显示
│   ├── settings.html   # 设置页面
│   ├── settings.js     # 配置编辑器
│   └── settings.css    # 设置页样式
├── build/              # 构建资源（图标等）
├── config.yaml         # 配置文件（需填入凭证）
└── package.json
```

## 技术栈

- **Electron** — 桌面应用框架
- **字节跳动豆包 ASR** — 流式语音识别（WebSocket + 二进制协议）
- **gzip 压缩** — 自定义二进制帧格式（4字节头 + 压缩 JSON）
- **AppleScript** — 模拟 Cmd+V 粘贴

## 工作流程

```
按下快捷键 → 开始录音 → 麦克风采集 PCM 音频 → 下采样至 16kHz
    → IPC 发送音频块 → WebSocket 转发至 ASR
    → 流式返回识别结果 → 浮动窗显示文本
再次按下 → 等待最终结果 → 写入剪贴板 → AppleScript 粘贴
```

## 系统要求

- macOS 12+
- Node.js 18+
- pnpm

## 开发

```bash
# 开发模式运行
pnpm dev

# 打包 macOS 应用
pnpm pack
```

## License

[MIT](LICENSE)
