# 模型服务设置重构 Plan

> 设计稿:`/Users/yolanda/Code/10-typepaste/ui/designs/model-services`(6 画板,含全部评论修订)
> 实施分支:`feature/model-services`(基于 master)

## 0. 已确认决策

| # | 决策 |
|---|------|
| 1 | UI + 数据层一起重构:registry v21 + config.yaml 迁移 + llm.rs 多模型 |
| 2 | LLM 模型 = registry 预置 + 用户手动添加 |
| 3 | 凭证卡 = URL + API Key 统一基底 + registry 声明的扩展字段(同卡追加,左 label 右 input) |
| 4 | 「测试」按钮本次实现,仅手动点击触发,不自动测试 |
| 5 | 「移除」供应商 = 彻底清除该供应商配置(含 API key) |
| 6 | 阿里云百炼本期不接入,只搭 provider 抽象 |
| 7 | LLM 模型抽屉带推理参数(temperature / max_tokens / top_p) |
| 8 | 「按语言筛选模型」去掉 |
| 9 | 全新安装主列表最小集 = 字节跳动 + 本地语音识别模型 |
| 10 | Sherpa-ONNX 界面显示名改为「本地语音识别模型」(不再出现 Sherpa-ONNX 字样) |
| 11 | 自定义兼容服务本期仅大语言 |
| 12 | 火山引擎 LLM(方舟 OpenAI 兼容)顺带接入;provider 显示名「火山引擎」→「字节跳动」/ "ByteDance" |
| 13 | 字段元数据按嫁接对象分层:凭证 → registry·能力级;模型参数值 → registry·模型级 + config 用户覆盖;推理参数 schema 与引擎协议 UI 元数据 → 代码(前者前端常量,后者 FIELD_META) |
| 14 | 模型可见性统一**正列表** `models`(不存在 = 全部预置),不设 hidden/tombstone;ASR 与 LLM 都支持移除预置模型 |
| 15 | 配置升级采用 **lazy 归一化**:读时兼容旧字段(内存归一),保存时只写新结构;旧字段解析保留 1-2 个版本后清理 |
| 16 | 凭证两层 scope:`shared`(供应商级,UI 在 tabs 上方)+ `asr`/`llm`(能力级,UI 在对应 tab 内);**不做模型级凭证**(本期无实例,schema 亦不预留,将来需要时升 registry 版本)。两层可组合:中转站 = shared key + asr/llm 各自 URL |
| 17 | ASR 凭证存储真迁移到能力级:新增 `audio.credentials.<provider>`,旧 `audio[模型id]` 中的凭证字段 lazy 归一化迁入,引擎(doubao.rs / elevenlabs.rs)读取路径同步调整 |

## 1. 数据层(Rust)

### 1.1 registry.json v21 — 新增 providers 层

models 保持平铺(减少对现有代码的破坏),新增 `provider` 字段关联;顶层新增 `providers` 数组:

```jsonc
{
  "version": 21,
  "providers": [
    {
      "id": "bytedance",
      "name": "字节跳动", "name_en": "ByteDance",
      "kind": "online",                    // online | local
      "capabilities": ["asr", "llm"],
      "docs_url": { "zh": "…申请指引…", "en": "…" },
      "credentials": {                     // 两层 scope,按需声明(见决策 16)
        "asr": {                          // 能力级:UI 放语音识别 tab 内
          "fields": [
            { "key": "url" },
            { "key": "api_key", "type": "password" },
            { "key": "app_id", "visible_when": { "auth_mode": "legacy" } },
            { "key": "access_token", "type": "password", "visible_when": { "auth_mode": "legacy" } },
            { "key": "auth_mode", "visible_when_legacy_creds": true }   // 特例:仅存量 legacy 用户显示
          ]
        },
        "llm": { "fields": [{ "key": "url" }, { "key": "api_key", "type": "password" }] }
        // 无 "shared":字节语音/大语言凭证完全分开。
        // 反例(将来):中转站/百炼 = { "shared": {fields:[api_key]}, "asr": {fields:[url]}, "llm": {fields:[url]} }
        // —— 共用 key 在 tabs 上方一张卡,两个 tab 各填自己的 URL
      }
    },
    { "id": "elevenlabs", "capabilities": ["asr"] /* 单能力:凭证直接声明在该能力下,详情页无 tabs,一张凭证卡 */ },
    { "id": "local_asr", "name": "本地语音识别模型", "name_en": "Local ASR", "kind": "local", "capabilities": ["asr"] },
    { "id": "deepseek" / "openai" / "anthropic" / "gemini" / "openrouter" / "siliconflow" / "ollama", "capabilities": ["llm"], … },
    { "id": "custom_openai", "name": "自定义兼容服务", "capabilities": ["llm"], … }
  ],
  "models": [
    // 现有条目全部加 "provider" 字段:
    //   doubao-streaming / elevenlabs-realtime → bytedance / elevenlabs
    //   sherpa-onnx-* (asr/vad/punctuation) → local_asr
    // 新增 LLM 模型条目(category: "llm"):
    //   bytedance: doubao-seed-1-6(默认)、doubao-seed-1-6-flash、doubao-1-5-pro-32k
    //   其余 LLM provider 各预置 1 个(沿用 llm.rs get_provider_defaults 现值,如 deepseek-flash)
    //   LLM 模型 default_config: { "model_id": "实际请求字符串" }
  ]
}
```

要点:
- **字段元数据分层**(决策 13/16):凭证字段声明在 `provider.credentials`(`shared` 供应商级 / `asr`·`llm` 能力级,两层可组合);参数默认值在 `model.default_config`(模型级);推理参数 schema(min/max/step 的 temperature/max_tokens/top_p 三件套)为前端代码常量,不进 registry —— 所有 LLM 模型均 OpenAI 兼容,聚合/中转平台(OpenRouter 类)下不同模型各异的是**值**,不是参数集;doubao/elevenlabs 引擎协议字段的 UI 元数据继续走 FIELD_META(代码);模型级凭证不做(决策 16)
- `doubao-streaming` 等 **模型 id 不变**(`audio.provider` 引用保持兼容);engine 字段(`volcengine`)内部 id 不变,仅显示名换「字节跳动」
- Doubao 三个预置模型(model_id 在抽屉可改,Ark 端点也可填 `ep-xxx`):
  1. **Doubao-Seed-1.6** — 通用旗舰,默认
  2. **Doubao-Seed-1.6-flash** — 低延迟低成本,语音润色场景推荐
  3. **Doubao-1.5-pro-32k** — 上一代稳定版
- `schemas/registry.schema.json` 同步更新
- `model.rs`:新增 `ProviderEntry` 结构 + v20→v21 升级 merge(已有 merge_registry 框架)+ 单测

### 1.2 config.yaml 结构变更 + lazy 归一化

ASR 侧 per-model 覆盖(`audio[modelId]`)、共享默认(`audio.asr_defaults`)不动;新增模型可见性正列表。

LLM 段扩展(向后兼容读取):

```yaml
llm:
  provider: bytedance        # 默认供应商 id
  default_model: ""          # 默认模型 id,空 = 该供应商可见模型的第一个
  bytedance:                 # 每 provider(能力级凭证 + 模型正列表)
    url: ""
    api_key: ""
    models:                  # 正列表;字段不存在 = 该 provider 全部预置模型
      - { id: doubao-seed-1-6, params: { temperature: 0.5 } }  # 预置模型(只存 delta,默认值跟随 registry)
      - { id: my-model, name: 我的模型 }                       # 自定义模型(id 即请求的 model 字符串)
```

ASR 侧同规则:

```yaml
audio:
  provider: doubao-streaming   # 不变
  models:                      # 正列表;不存在 = 全部预置模型(含本地/基础组件)
    - doubao-streaming
    - elevenlabs-realtime
  credentials:                 # ASR 能力级凭证(决策 17,新)
    bytedance: { url: …, api_key: … }
    elevenlabs: { api_key: … }
  # 本地模型的"已下载"仍由磁盘状态决定,不入此列表
  # audio[modelId] 保留,但只存非凭证的模型参数(language、enable_itn 等)
```

**凭证存储位置总表**(与 registry 两层 scope 对齐):

| scope | 存储位置 | 说明 |
|-------|---------|------|
| `shared`(供应商级) | `model_providers.credentials.<provider_id>` | 本期无内置实例,结构生效 |
| `asr`(能力级) | `audio.credentials.<provider_id>` | 从旧 `audio[模型id]` 迁入(见归一化表) |
| `llm`(能力级) | `llm.<provider>.{url, api_key}` | 现状不动 |
| ~~模型级~~ | 不做(决策 16) | 将来需要时升 registry 版本 |

正列表语义(ASR/LLM 共用一套 merge helper):
- `models` 不存在 → 显示 registry 全部预置模型(新供应商零配置即可用)
- `models` 存在 → 列表即事实;删预置 = 移出列表,自定义 = 加入列表
- registry 升级新增预置模型:列表不存在的用户自动看到;列表存在的用户不自动出现,「添加模型」弹窗列出"预置 − 已在列表"可一键加入(不自动追加,避免 union 合并复活已删模型、避免引入 tombstone)
- 预置模型条目只存 id + 用户 delta(params 等),registry 升级 default_config 自动生效

新增顶层段(供应商可见性,跨 asr/llm 能力):

```yaml
model_providers:
  added: ["bytedance", "local_asr"]   # 主列表显示哪些(默认值同左)
```

**lazy 归一化规则**(config.rs 读取归一化,决策 15;不写一次性迁移脚本):

| 旧字段 | 归一化目标 |
|--------|-----------|
| `audio[模型id]` 中的凭证字段(url / api_key / app_id / access_token / auth_mode,按 registry 凭证字段 key 集合判定) | 迁入 `audio.credentials.<provider_id>`(决策 17);`audio[模型id]` 只留非凭证参数。引擎 resolve 合并顺序:registry 默认 ← `audio.credentials.<provider>`(凭证)← `audio[模型id]`(参数),doubao.rs / elevenlabs.rs 读取路径与前端写入路径同步调整 |
| `llm.<key>.model`(旧单模型) | 与该供应商预置模型 id/model_id 匹配 → 映射为预置 id 并设为 `default_model`;不匹配 → 转为 `models` 自定义条目并设为 `default_model` |
| `llm.url / api_key / model` 顶层旧字段(openai_compatible fallback) | 归入对应 provider 凭证 |
| `model_providers.added` 不存在 | 推导:`{bytedance, local_asr}` ∪ 当前 `llm.provider` ∪ 有凭证的 LLM provider ∪ `audio.provider` 所属供应商(用过 ElevenLabs 的自动看到 ElevenLabs) |
| `llm.default_model` 不存在 | 取归一后该 provider 可见模型第一个 |
| `audio.models` 不存在 | 全部预置显示,零迁移 |

- 原则:**读兼容旧、写只写新** —— 用户保存一次后文件自然升级;旧字段解析保留 1-2 个版本后清理
- Electron→Tauri 老路径:migration.rs 产出的现行结构自动落入上述归一化,无需改动
- 新装默认 LLM 供应商 `deepseek` → `bytedance`(llm.rs `default_llm_provider()` 调整)

### 1.3 llm.rs 改造

- `ProviderConfig` 增加 `models`(正列表,serde default,旧配置照常解析);推理参数 schema 为代码常量(temperature 0–2 / max_tokens 1–32768 / top_p 0–1,仅显式设置才携带进请求体)
- `get_active_provider_config` → 返回 `(url, api_key, model_id, params)`:`model_id` 按 `llm.default_model` → 可见模型第一个 → 旧 `model` 字段 的顺序解析;预置模型 id 经 registry 映射为实际请求字符串(可被用户 delta 覆盖)
- `get_provider_defaults` 增加 `bytedance` 条目(`https://ark.cn-beijing.volces.com/api/v3/chat/completions`);预置模型列表由调用方从 registry(state)传入,不在 llm.rs 硬编码第二份
- `validate_llm_config` 适配新解析逻辑,错误 field 定位到 provider/model

### 1.4 新增 IPC + 错误码

- `test_provider_connection(provider_id, capability)` — 仅手动触发:
  - LLM:POST chat/completions,`max_tokens=1`,消息 "hi"
  - ASR doubao / elevenlabs:WebSocket 握手 + 鉴权,等待首个 ack/error 帧后立即关闭
  - 返回 `Ok` 或 `AppError`
- 新增错误码:`llm.test_failed`、`asr.test_failed`(params: provider)——errors.rs 的 locale-coverage 测试要求 zh-CN/en 双语条目同步
- 供应商增删、凭证编辑、模型增删全部经现有 `save_config_object` 落盘,无新增写 IPC

## 2. 前端(web/src/settings)

### 2.1 导航

- Sidebar:「模型」分组下 `service` + `llm` 两项合并为单项 **「模型服务」**(id `models`)
- 页面内部两级导航(组件内 state,不引 router):`main` ↔ `provider detail`(携带 providerId)
- onboarding tour 的 asr/llm 任务重定向到新页面,`data-tour` 钩子重新布置(入口 → 默认卡 → 字节跳动详情 → 凭证),steps.ts 与 locale 文案同步改

### 2.2 新文件

| 文件 | 职责 |
|------|------|
| `pages/models/ModelServicesPage.tsx` | Main:当前默认卡(两个「供应商 / 模型名」下拉)、筛选行(全部/在线/本地 + 自定义配置 + 添加供应商)、供应商列表 |
| `pages/models/ProviderDetailPage.tsx` | 详情:返回、头部(logo/名称/如何申请/移除)、能力 tabs(语音识别/大语言)、凭证卡(**shared 卡放 tabs 上方、能力级卡放对应 tab 内**,单能力供应商无 tabs 一张卡)、模型列表;`local_asr` 无 tabs 无凭证,直接模型区 + 「基础组件」子区(Silero VAD、CT-Transformer) |
| `components/models/ModelConfigDrawer.tsx` | 模型配置抽屉:常用字段直出 + 高级参数折叠;底部 移除模型 / 恢复默认 / 完成 |
| `components/models/AddProviderModal.tsx` | 两列卡片目录(基于现有 Modal),整卡点击添加 |
| `components/Drawer.tsx` | 通用右侧抽屉容器(scrim、Esc 关闭、焦点圈定) |

删除:`pages/AudioModelPage.tsx`、`pages/LLMPage.tsx`、`components/ModelCard.tsx` 的卡片 UI。

### 2.3 复用(以现有控件为准)

- 字段渲染:`renderControl` + `FIELD_META` + `SectionItem` 数据驱动机制原样保留,只是容器从「卡片展开」换成「抽屉」
- `lib/model.ts`:FIELD_META 增加 LLM 推理参数(temperature/max_tokens/top_p)与 model_id/名称元数据;`group: "credentials"` 字段改由 ProviderDetailPage 凭证卡渲染(Doubao legacy 的 auth_mode 双轨逻辑迁移过去)
- 既有控件全部复用:Select / Toggle / SegmentedControl / Input / Modal / Tooltip / Badge / Button / Toast
- `CustomConfigModal`(asr_defaults)原样保留,入口按设计稿放筛选行右侧
- 下载进度(`onModelDownloadProgress`)、`downloadModel` / `deleteModel` 逻辑迁移到 ProviderDetailPage

### 2.4 交互细则

- **默认卡**:ASR 下拉候选 = 已添加供应商的 asr 模型(本地需已下载);LLM 下拉候选 = 已添加供应商的 llm 模型。切换 ASR = 写 `audio.provider`;切换 LLM = 写 `llm.provider + llm.default_model`
- **供应商行**:图标 + 名称 + 标签(语音/文本/本地)+ 箭头;`local_asr` 固定显示(本地模型与基础组件管理入口)
- **移除供应商**:确认弹窗 → 从 `model_providers.added` 移除 + 清空该 provider 凭证/模型用户态(LLM);本地 provider 移除不删已下载模型文件,重新添加后仍在。若被移除供应商承载当前默认模型 → 默认回落(ASR `doubao-streaming`;LLM bytedance 预置第一个)并 toast 提示
- **移除模型**(抽屉左下,ASR/LLM 均支持):预置模型 = 从正列表 `models` 移除(audio / llm 同规则);自定义模型 = 移出列表即删;本地模型 = `deleteModel` 删文件(下载态与可见性解耦)。移除的是当前默认模型时 → 回落到该能力剩余可见模型第一个(优先 `doubao-streaming` / bytedance 预置)并 toast 提示
- **添加模型**:LLM = 弹窗输入 model id + 显示名,同时列出"预置 − 已在列表"可恢复;ASR = 列出被移除的预置模型恢复(本期不支持自定义 ASR 模型)
- **测试按钮**:loading → 成功/失败 toast(错误码走 errText);绿勾 = 凭证必填项已填(纯前端),与测试结果解耦
- **凭证字段**:registry 两层声明驱动渲染,统一左 label 右 input;`shared` 卡在 tabs 上方(共用 key 填一次)、能力级卡在对应 tab 内;Ollama 仅 URL;绿勾 = 该 scope 必填项已填(纯前端)

### 2.5 i18n

- `ui.models.*` 新增全套 key(zh-CN + en);移除废弃 key(`ui.audio.*` 部分保留给 CustomConfigModal)
- 图标:各 provider 用 lucide/内置 SVG 简笔标识(本期不做品牌 logo 图片,统一几何图标 + 首字母)

## 3. 测试

| 层 | 内容 |
|----|------|
| Rust 单测 | registry v21 解析/merge 升级;config LLM 新结构读写 + lazy 归一化全规则表(tempfile);ASR 凭证迁出 `audio[模型id]` → `audio.credentials.<provider>` 与 resolve 合并顺序;`models` 正列表 merge helper(不存在=全显 / 存在即事实 / registry 新增不自动追加);llm.rs model_id 解析优先级 + params 请求体(wiremock);test_provider_connection LLM 路径(wiremock) |
| 前端 vitest | 默认卡候选/选择写入逻辑、正列表增删与回落逻辑、AddProviderModal/ModelDrawer 组件行为(mock bridge);onboarding 测试适配 |
| 收尾 | `pnpm check` 零告警、`cargo test`、`npx vitest run` 全绿;`pnpm dev` 手工冒烟(旧配置迁移、添加/移除供应商、抽屉、测试按钮) |

## 4. 实施顺序

1. registry v21 + schema + model.rs(含升级 merge)+ 单测
2. config.rs LLM 新结构 + 迁移归一化 + llm.rs(ark、params、默认 provider)+ 单测
3. `test_provider_connection` IPC + 错误码 + 双语 locale
4. 前端 types/bridge/lib(model.ts 扩展、RegistryProvider 类型)
5. Drawer / AddProviderModal / ModelServicesPage / ProviderDetailPage / ModelConfigDrawer
6. Sidebar 合并、onboarding 适配、locale 清理
7. 全量检查 + 手工冒烟,PR

## 5. 本期不做

- 阿里云百炼等新引擎接入(结构已就绪,加数据即可)
- 模型级凭证(每模型独立 key)——本期无实例,schema 亦不预留(决策 16)
- 使用 `shared` 共用凭证的内置供应商实例 —— 两层结构本期生效,首个实例将是自定义兼容服务或百炼类接入
- 自定义兼容服务的语音能力
- Ollama 已拉取模型自动发现(`/api/tags`),本期手动输入
- 按语言筛选模型
