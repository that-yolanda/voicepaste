# 开发说明

## 本地运行

```bash
pnpm install
pnpm dev
```

## 打包

```bash
pnpm pack                                 # 全量打包（不含签名）
pnpm pack -s                              # 全量打包 + 签名与公证
pnpm pack -p mac-arm64                    # 仅 macOS Apple Silicon
pnpm pack -p mac-x64                      # 仅 macOS Intel
pnpm pack -p win-x64                      # 仅 Windows x64
pnpm pack -p mac-arm64,mac-x64            # macOS 双架构
```

### 代码签名与公证（macOS）

不加 `-s` 参数时，打包会跳过代码签名和公证，可以正常使用，但每次重装 macOS 会重置权限（麦克风、辅助功能等）。

如需启用正式签名和公证：

1. 从 [developer.apple.com](https://developer.apple.com) 获取 **Developer ID Application** 证书，安装到 Keychain。
2. 在 [appleid.apple.com](https://appleid.apple.com) → 应用专用密码 中生成一个密码。
3. 将 `.env.example` 复制为 `.env` 并填写凭据：

```bash
cp .env.example .env
```

```env
APPLE_ID=你的AppleID邮箱
APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
APPLE_TEAM_ID=你的团队ID
CSC_NAME=Developer ID Application: 你的名字 (团队ID)
# 可选：设为 false 后，未命中指定证书时直接失败，避免误选其他证书
# CSC_IDENTITY_AUTO_DISCOVERY=false
```

4. 运行 `pnpm pack -s`：
   - 若设置了 `CSC_NAME`，构建会固定使用这张 Keychain 证书签名。
   - 若未设置 `CSC_NAME`，构建会自动从 Keychain 查找可用证书。
   - `.env` 中的 `APPLE_*` 变量会用于公证。
   - 不加 `-s` 时签名被禁用，会自动设置 `CSC_IDENTITY_AUTO_DISCOVERY=false`。

`.env` 文件已在 `.gitignore` 中，不会被提交。

## 说明

- 项目基于 Electron，使用 CommonJS，不使用前端 bundler。
- `config.yaml` 已加入忽略，用于本地填写真实凭证。
- `config.yaml.example` 是打包产物默认携带的模板配置。
- 当前桌面平台支持 macOS 和 Windows。

## 项目结构

```text
voicepaste/
├── main/               # Electron 主进程
│   ├── main.js         # 应用入口、状态机与快捷键管理
│   ├── asrService.js   # WebSocket ASR 客户端（二进制协议）
│   ├── pasteService.js # 剪贴板写入与模拟粘贴
│   ├── windowManager.js# 窗口创建与管理
│   ├── config.js       # 配置加载与热重载
│   └── logger.js       # 日志模块
├── preload/            # Preload 脚本
│   └── preload.js      # contextBridge API
├── renderer/           # 渲染进程
│   ├── index.html      # 浮动覆盖窗口
│   ├── app.js          # 音频采集与文本显示
│   ├── settings.html   # 设置页
│   ├── settings.js     # 配置编辑器
│   └── settings.css    # 设置页样式
├── build/              # 构建资源
├── docs/               # 文档、更新说明、截图
├── config.yaml         # 本地运行配置
├── config.yaml.example # 打包默认模板配置
└── package.json
```

## 技术栈

- Electron
- 字节跳动豆包 ASR（WebSocket）
- gzip 压缩二进制帧
- macOS 使用 AppleScript、Windows 使用 PowerShell 模拟粘贴
- `uIOhook` 用于录制自定义快捷键组合

## 工作流程

```text
按下快捷键 → 开始录音 → 麦克风采集 PCM 音频 → 下采样到 16kHz
  → 通过 IPC 发送音频块 → WebSocket 转发到 ASR 服务
  → 流式返回识别结果 → 悬浮窗显示文本
再次按下 → 等待最终结果 → 写入剪贴板 → 模拟粘贴
```

## 系统要求

- macOS 12+ / Windows 10+
- Node.js 18+
- pnpm
