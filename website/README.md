# VoicePaste Website

正式网站，独立于 Tauri 桌面前端 `web/`。

## 第一阶段

- Next.js App Router + TypeScript + Tailwind CSS v4。
- shadcn/ui 预设 `b1zdbJvWhE`，Base UI / Nova，保留预设标题、正文字体与颜色；Header / Footer 的品牌字标单独使用用户选定的 Sora。
- 首页：产品演示、三个场景、核心特性、FAQ、下载入口。
- 下载页：Apple Silicon、Intel、Windows，独立安装包与近期历史版本。
- Fumadocs + MDX：8 篇中文和 8 篇英文文档，支持目录、分页、搜索。
- 默认深色，允许手动切换并保存。
- 语言独立网址、SEO 元数据、语言对应链接、站点地图、robots、分享图。

网站反馈页面现支持文字、可选联系方式（中文页可填邮箱或微信号）、日志与截图，由 Next.js 后端通过 Resend 发送邮件。不提供数据库、登录或 APP 内反馈。

## 开发

从仓库根目录运行：

```bash
pnpm --dir website install
pnpm --dir website dev
```

首页入口：<http://localhost:3000/>。中文：`/zh`；英文：`/en`。

如果 macOS 提示 `EMFILE`（文件监听数量限制），在启动开发服务的同一个终端先执行 `ulimit -n 8192`。

```bash
pnpm --dir website test
pnpm --dir website lint
pnpm --dir website typecheck
pnpm --dir website build
pnpm --dir website start
```

依赖、锁文件、构建和 Next 配置均属于本目录，不修改桌面项目的构建方式。首次安装后 `fumadocs-mdx` 会生成被忽略的 `.source/` 文档类型文件。

## 语言规则

- 只对缺少语言前缀的首页、文档、下载和反馈入口进行语言跳转。
- 优先读取用户手动选择的 `voicepaste-locale` Cookie，其次根据浏览器 `Accept-Language` 的权重匹配中文或英文；没有匹配时使用英文。
- 直接访问 `/en/…` 或 `/zh/…` 时尊重网址，不自动重定向。
- 手动切换保留当前页面、查询参数和锚点；不使用 JavaScript 在浏览器里替换整页文字。
- 页面独立输出对应语言 HTML、canonical、hreflang；`x-default` 指向英文。
- 深浅色共用 Fumadocs 根 Provider，不叠加第二个 ThemeProvider。首访默认深色，不跟随系统主题。

## 内容维护

| 位置 | 内容 |
| --- | --- |
| `components/home-content.tsx` | 首页静态内容与布局 |
| `components/features.tsx` | 功能演示网格与透明背景概念配图 |
| `components/platform-icon.tsx` | Apple / Windows 品牌图标 |
| `components/product-demos.tsx` | 进入视口后播放的场景、视频与提示音视觉演示 |
| `lib/scenarios.ts`、`lib/faq.json` | 场景与常见问题双语文案 |
| `content/docs/*.mdx` | 英文文档；对应 `*.zh.mdx` 为中文 |
| `content/docs/meta*.json` | 各语言目录顺序 |
| `config/releases.json` | 最新版本标记、历史版本、各平台安装包地址及自动同步的双语日志 |
| `app/globals.css` | shadcn 预设与全站主题 |
| `app/marketing.css` | 首页布局、产品浮层与动效 |
| `lib/seo.ts` | SEO 元数据规则 |

发布新版本时：

1. 在根目录 `CHANGELOG.md`、`CHANGELOG.zh.md` 编写对应版本的日志，GitHub Release 正文也以此为源。
2. 上传并核对安装包后，在 `config/releases.json` 添加版本、实际发布日期及文件信息，再更新 `latest`。日志日期与实际发布日期可以不同。
3. 运行 `pnpm --dir website releases:sync`，按版本提取双语 Markdown 到 `notes.en` / `notes.zh`。不要手工编辑这些字段，换行和引号由脚本转义。
4. 将日志与同步后的 JSON 一并发布网站。`test` 和 `build` 会检查是否同步；缺失翻译、重复版本或正文过期会报错。

首页、下载与更新日志页面共用这一份配置，浏览时不依赖 GitHub API。当前仅展示 JSON 已收录的版本，源文件中更早的日志继续保留。

### 发布信息接口

`GET /api/releases` 默认返回英文；`?lang=zh` 返回中文，`?version=2.1.5&lang=zh` 查询单个版本（版本号允许带 `v`）。返回 `{ "releases": [...] }`，每条记录包含 `version`、`date`、`releaseUrl`、`files` 和当前语言的 Markdown `notes`。

不支持的语言返回 400，不存在的版本返回 404。成功响应缓存 5 分钟；数据随网站部署更新。接口公开，无需鉴权，目前不分页。未来 App 可按需读取；本次未修改 App 的更新检测、签名验证或安装流程。

新增控件在 `website/` 内运行 shadcn 命令，避免 CLI 识别到根目录的 Vite 桌面项目：

```bash
cd website
pnpm dlx shadcn@latest add <component>
```

## 上线前

### 反馈邮件配置

1. 在 Resend 验证计划使用的发信域名，只启用 Sending，保持 Receiving 关闭；保留 Cloudflare 原有收信 MX 和转发规则。
2. 在 Vercel 项目环境变量中设置 `RESEND_API_KEY`（仅发送权限）、`FEEDBACK_FROM`（已验证域名下的发件地址）、`FEEDBACK_TO`（约定的收件邮箱）。不要将真实密钥或私人收件地址提交到仓库。保持 `NEXT_PUBLIC_SITE_URL` 与表单访问的正式域名一致；别名域名应重定向到此域名。
3. 发布前在 Vercel Firewall 配置限流：路径精确匹配 `/api/feedback` 或 `/api/feedback/app`、方法为 `POST`、按 IP 统计、每 10 分钟最多 5 次，超限返回 429，并发布规则。代码不自行计数，不使用 Turnstile。只有发布并验证规则后才能认为限流生效。
4. 开发／预览使用独立环境配置；未设置配置时接口返回 503，不会返回假成功。自动化测试使用 mock Resend；本地或预览接口若配置真实环境变量，提交时会调用真实 Resend。
5. 另行进行真实收信验收：检查正文、日志脱敏、截图、Reply-To；再从其他邮箱测试 Cloudflare 转发。Resend 接受请求不代表邮件已进入收件箱。集中滥用仍可能消耗额度，出现持续垃圾反馈后再评估验证码。

反馈页面为 `/zh/feedback` 和 `/en/feedback`。`POST /api/feedback` 接收 multipart 表单：`type`（bug/feature/other）、选填的 `category`（与类型对应的模块标识）、`title`、`description`、选填的 `email` 和 `wechat`、必填的 `appVersion` 和 `system`、`submissionId`（UUID v4）、可选 `log` 和最多四个 `screenshots` 文件。中文页提供邮箱和微信号，英文页仅显示邮箱：邮箱非空时校验格式，微信号不校验账号格式；两者均可留空。发件人与收件人不能由表单覆盖。

`POST /api/feedback/app` 供桌面 App 的 Rust 客户端调用，使用相同字段、附件限制和邮件处理；此入口不要求官网 Origin，并拒绝带 Origin 或 Sec-Fetch-Site 的浏览器请求。来源检查不是身份验证，两个入口必须一并配置限流。App 自动填写版本和系统信息，仅在用户勾选时附加指定运行日志；截图由用户选择，不读取配置文件、录音或输入历史。先部署此接口及限流规则，再测试桌面提交。

成功返回 202 `{ ok: true, submissionId }`；字段／文件错误返回 400，来源不符返回 403，请求过大返回 413，格式不支持返回 415，配置缺失返回 503，发信失败或无法确认结果返回 502。应用错误返回 `{ error: code }`；平台限流的 429 及平台大小限制错误可能不是 JSON，前端按状态码处理。

最多一个 UTF-8 文本日志（.log/.txt，512 KiB）、四张 PNG/JPEG 截图（每张 2 MiB），附件合计 3 MiB，整个请求体 3.5 MiB。仅检查图片签名，不执行图片解码、OCR 或截图脱敏。服务端不落盘或记录反馈内容。相同内容重试复用提交 UUID，Resend 幂等键同时绑定确定性邮件内容摘要；不自动重试发信。

### 其他上线事项

1. 复制 `.env.example` 为 `.env.local`，将 `NEXT_PUBLIC_SITE_URL` 设置成正式域名后重新构建；目前的 localhost 仅供本地验证。
2. 替换旧版 Hero 录屏和文档里的设置截图。首页功能区使用交互演示和两张透明背景概念配图；交互演示不会调用真实语音识别，玻璃浮层是网页示意。
3. 选择托管平台并验证域名、搜索与图片优化。本次只本地运行，没有部署、推送或提交。

提示音功能仅作视觉演示，不播放音频；循环演示离开视口或切到后台时停止，并遵循系统减少动态效果设置。

## 本轮视觉细化

- 手机主菜单改为纵向、每项至少 48px 高。
- 场景标题改为「一句口述，多种表达。」；保留语音输入、翻译、文本润色三个演示入口，不增加提示词副标题。
- 模拟窗口增加低对比边界；录音条按桌面源码的 40px 单行高度、四条波形、14px 字号和状态切换调整，长文字自动换行。
- 桌面前四项功能使用 2:1 网格，模板与热词配图并排；平板前四项改为单列，手机全部使用单列。
- 配图保存在 `public/assets/illustrations/`，完整生成提示词在同目录 `prompts.json`。品牌图标来源记录在 `public/assets/brands/CREDITS.md`。
- 功能标题、说明、下载链接、图片描述均在服务端 HTML 中；动画停止、禁用脚本时仍保留可读内容。
- macOS 原生 App 已打开，但本次未取得真实录音状态截图；网页浮层当前以源码参数为依据，不能当作原生液态玻璃效果的运行验证。
