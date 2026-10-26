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

本阶段不实现反馈表单、邮件中转、数据库或登录。反馈入口暂时使用 GitHub Issues，第二阶段再讨论 Resend 与 Gmail 收件配置。

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

- 只对缺少语言前缀的首页、文档和下载入口进行临时跳转。
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
