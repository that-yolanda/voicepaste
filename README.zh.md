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


---

## API 获取
- 登录[火山引擎控制台](https://console.volcengine.com/speech/app)，创建一个应用，选择"豆包流式语音识别模型2.0 小时版"

![Create App](docs/api-step1.png)

- 进入对应模型，选择创建的 app，并开通模型包，下方可以看到 APP ID，	Access Token，Secret Key

![Get Credentials](docs/api-step2.png)

- 填入配置页面填入凭证，点击保存即可

![Save Config](docs/api-step3.png)



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

## FAQ

### macOS 上无法使用？

VoicePaste 需要 **麦克风权限** 和 **辅助功能权限** 才能正常工作。

**麦克风权限**

1. 配置页面 → 系统权限 → 点击「请求权限」
2. 系统设置 → 隐私与安全 → 麦克风，确保 VoicePaste 已被授权
3. 若之前拒绝过，可通过终端重置权限后重新授权：
```bash
tccutil reset Microphone com.yolanda.voicepaste
```

**辅助功能权限**

1. 系统设置 → 隐私与安全 → 辅助功能，确保 VoicePaste 已被授权
2. 若删除后重新安装，需重新添加

### 二遍识别开启后，热词在流式识别中正确但最终结果错误？

二遍识别（non-stream）模式下，官方当前不支持热词库和注入热词，仅支持替换库。建议在[火山引擎控制台](https://console.volcengine.com/speech/correctword)创建替换库，并在配置中将 `boosting_table_id` 替换为 `correct_table_id`。

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

---

## 更新说明

### v1.1.0 (2025-04)

- **UI 重构** — 全新 Claude 风格界面设计，温暖极简主义配色方案
- **Overlay 优化** — 消除语音输入过程中文字闪烁，平滑横向扩展动画
- **跨平台字体** — 统一 macOS / Windows 无衬线字体，中英文一致体验
- **外部链接** — 设置页面链接改为系统默认浏览器打开
- **设置页面** — 新增 GitHub 仓库入口，section 统一赤陶色主题
- **FAQ** — 新增常见问题（macOS 权限、二遍识别热词、Windows 兼容性）

### v1.0.0 (2025-03)

- 初始版本发布
- 全局快捷键语音输入
- 字节跳动豆包 ASR 流式识别
- 自动粘贴到当前输入框
- 浮动窗口实时显示识别进度
- 热词支持
