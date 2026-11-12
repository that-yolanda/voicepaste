import Link from "next/link"
import { Check } from "lucide-react"
import type { Locale } from "@/lib/i18n"
import asrModels from "@/lib/model-support.json"

const llmServices = [
  { name: ["千问/百炼", "Qwen / Bailian"], online: true, guide: "api/qwen" },
  {
    name: ["火山引擎", "Volcengine"],
    online: true,
    guide: "api/volcengine#text-models",
  },
  { name: ["DeepSeek", "DeepSeek"], online: true, guide: "api/deepseek" },
  { name: ["OpenAI", "OpenAI"], online: true, guide: "templates" },
  { name: ["Gemini", "Gemini"], online: true, guide: "templates" },
  { name: ["Anthropic", "Anthropic"], online: true, guide: "templates" },
  { name: ["硅基流动", "SiliconFlow"], online: true, guide: "templates" },
  { name: ["OpenRouter", "OpenRouter"], online: true, guide: "templates" },
  { name: ["Ollama", "Ollama"], online: false, guide: "templates" },
] as const

const speechGuides: Record<string, string> = {
  bytedance: "api/volcengine",
  elevenlabs: "api/elevenlabs",
  qwen: "api/qwen",
  local_asr: "local-models",
}

const capabilityColumns = [
  ["streaming", "流式输出", "Streaming output"],
  ["hotwords", "热词", "Hotwords"],
  ["smoothing", "语义顺滑", "Speech cleanup"],
  ["punctuation", "自动标点", "Auto punctuation"],
  ["itn", "数字格式化", "Number formatting"],
] as const

function ModelLanguages({
  codes,
  locale,
}: {
  codes: string[]
  locale: Locale
}) {
  const en = locale === "en"
  const names = new Intl.DisplayNames([locale], { type: "language" })
  const languages = codes.map((code) => names.of(code) ?? code)
  const separator = en ? ", " : "、"
  return <p>{languages.join(separator)}</p>
}

export function RecognitionModelsTable({
  locale,
  detailed = false,
}: {
  locale: Locale
  detailed?: boolean
}) {
  const en = locale === "en"
  const index = en ? 1 : 0
  const title = en ? "Speech recognition" : "语音识别"
  return (
    <div
      className="model-table-scroll"
      role="region"
      aria-label={title}
      tabIndex={0}
    >
      <table
        className={`model-table ${detailed ? "model-table-detailed" : ""}`}
      >
        <caption className="sr-only">{title}</caption>
        <thead>
          <tr>
            {detailed && <th scope="col">{en ? "Provider" : "供应商"}</th>}
            <th scope="col">{en ? "Model" : "模型"}</th>
            <th scope="col">{en ? "Runs" : "运行"}</th>
            <th scope="col">{en ? "Languages" : "语言"}</th>
            {detailed && (
              <>
                {capabilityColumns.map(([key, zh, english]) => (
                  <th scope="col" key={key} className="model-capability">
                    {en ? english : zh}
                  </th>
                ))}
                <th scope="col">{en ? "Setup guide" : "配置指南"}</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {asrModels.map((model, row) => (
            <tr key={model.id}>
              {detailed &&
                (row === 0 ||
                  asrModels[row - 1].providerId !== model.providerId) && (
                  <th
                    scope="rowgroup"
                    rowSpan={
                      asrModels.filter(
                        (item) => item.providerId === model.providerId
                      ).length
                    }
                  >
                    {model.provider[index]}
                  </th>
                )}
              <th scope="row">{model.name[index]}</th>
              <td>
                {model.online
                  ? en
                    ? "Online"
                    : "在线"
                  : en
                    ? "Local"
                    : "本地"}
              </td>
              <td className="model-features">
                <ModelLanguages codes={model.languages} locale={locale} />
              </td>
              {detailed && (
                <>
                  {capabilityColumns.map(([key]) => (
                    <td key={key} className="model-capability">
                      <span className="sr-only">
                        {model.capabilities[key]
                          ? en
                            ? "Yes"
                            : "支持"
                          : en
                            ? "No"
                            : "不支持"}
                      </span>
                      {model.capabilities[key] ? (
                        <Check
                          size={16}
                          className="mx-auto"
                          aria-hidden="true"
                        />
                      ) : (
                        <span aria-hidden="true">—</span>
                      )}
                    </td>
                  ))}
                  <td>
                    <Link
                      href={`/${locale}/docs/${speechGuides[model.providerId]}`}
                    >
                      {en ? "Configure" : "配置指南"}
                    </Link>
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function PolishingServicesTable({
  locale,
  detailed = false,
}: {
  locale: Locale
  detailed?: boolean
}) {
  const en = locale === "en"
  const title = en ? "Text polishing" : "文本润色"
  return (
    <div
      className="model-table-scroll"
      role="region"
      aria-label={title}
      tabIndex={0}
    >
      <table className="model-table">
        <caption className="sr-only">{title}</caption>
        <thead>
          <tr>
            <th scope="col">{en ? "Provider" : "供应商"}</th>
            <th scope="col">{en ? "Runs" : "运行"}</th>
            {detailed && <th scope="col">{en ? "Setup guide" : "配置指南"}</th>}
          </tr>
        </thead>
        <tbody>
          {llmServices.map((service) => (
            <tr key={service.name[1]}>
              <th scope="row">{service.name[en ? 1 : 0]}</th>
              <td>
                {service.online
                  ? en
                    ? "Online"
                    : "在线"
                  : en
                    ? "Local"
                    : "本地"}
              </td>
              {detailed && (
                <td>
                  <Link href={`/${locale}/docs/${service.guide}`}>
                    {en ? "Configure service" : "配置服务"}
                  </Link>
                </td>
              )}
            </tr>
          ))}
          {detailed && (
            <tr>
              <th scope="row">
                {en
                  ? "Custom OpenAI-compatible service"
                  : "自定义 OpenAI 兼容服务"}
              </th>
              <td>{en ? "Online / Local" : "在线 / 本地"}</td>
              <td>
                <Link href={`/${locale}/docs/templates`}>
                  {en ? "Configure service" : "配置服务"}
                </Link>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

export function ModelTables({ locale }: { locale: Locale }) {
  const en = locale === "en"
  return (
    <div className="model-tables">
      <section>
        <h3 className="model-table-title">
          {en ? "Speech recognition" : "语音识别"}
        </h3>
        <RecognitionModelsTable locale={locale} />
      </section>
      <section>
        <h3 className="model-table-title">
          {en ? "Text polishing" : "文本润色"}
        </h3>
        <PolishingServicesTable locale={locale} />
      </section>
    </div>
  )
}

export function SupportedModels({ locale }: { locale: Locale }) {
  const en = locale === "en"
  return (
    <section
      className="supported-models wrap section-space"
      aria-labelledby="models-title"
    >
      <h2 id="models-title" className="reveal text-head">
        {en ? "Supported models" : "支持模型"}
      </h2>
      <p className="mt-6 max-w-3xl text-muted-foreground">
        {en
          ? "Bring your own API key for online models. Keep audio and text on your device with local recognition and polishing."
          : "在线模型，填写自己申请的 API Key；本地识别与润色，让音频和文本留在设备上。"}
      </p>
      <ModelTables locale={locale} />
      <Link
        className="mt-7 inline-block text-sm text-foreground underline underline-offset-[5px]"
        href={`/${locale}/docs/compatibility`}
      >
        {en ? "View compatibility list" : "查看完整兼容清单"} ↗
      </Link>
    </section>
  )
}
