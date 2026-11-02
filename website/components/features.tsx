import Image from "next/image"
import type { Locale } from "@/lib/i18n"
import {
  StreamDemo,
  LanguageDemo,
  SoundDemo,
  TemplateChoiceDemo,
} from "./product-demos"

function IllustratedFeature({
  locale,
  type,
}: {
  locale: Locale
  type: "templates" | "hotwords"
}) {
  const en = locale === "en"
  const template = type === "templates"
  const title = template
    ? en
      ? "A template for every task."
      : "不同表达，各有模板。"
    : en
      ? "Make your vocabulary count."
      : "你的词，记得更准。"
  const description = template
    ? en
      ? "Separate prompts and shortcuts, for the way you want to write."
      : "独立提示词、独立快捷键，让输出符合这一次的需要。"
    : en
      ? "Add names, products and specialist terms to your hotword lists."
      : "人名、产品名、专业术语，都可以加入热词库。"
  const alt = template
    ? en
      ? "Loose thoughts arranged into a letter, a checklist and a note"
      : "零散想法整理成邮件、清单和笔记的概念配图"
    : en
      ? "Personal vocabulary illustrated with VoicePaste, Ollama and macOS"
      : "以 VoicePaste、Ollama 和 macOS 展示自定义词汇的概念配图"
  return (
    <article className="feature-card">
      <div className="feature-copy">
        <h3 className="text-lead">{title}</h3>
        <p className="mt-4">{description}</p>
      </div>
      <div className="feature-canvas illustration-canvas">
        <Image
          src={`/assets/illustrations/${type}-transparent.png`}
          width={1536}
          height={1024}
          alt={alt}
          sizes="(max-width: 640px) calc(100vw - 88px), 560px"
          className="feature-illustration"
        />
        {template && (
          <div className="template-keys" aria-hidden="true">
            {[1, 2, 3].map((key) => (
              <span key={key}>
                <kbd>Fn</kbd>
                <span>+</span>
                <kbd>{key}</kbd>
              </span>
            ))}
          </div>
        )}
      </div>
      {template && (
        <p className="mt-4 text-sm text-muted-foreground">
          {en
            ? "Example shortcuts. Set your own keys for each template."
            : "快捷键仅为示例，每个模板都可自定义。"}
        </p>
      )}
    </article>
  )
}
export function Features({ locale }: { locale: Locale }) {
  const en = locale === "en"
  return (
    <section
      id="features"
      className="features-section section-space"
      aria-labelledby="features-title"
    >
      <div className="wrap">
        <h2 id="features-title" className="reveal text-head">
          {en ? "Keep your train of thought." : "思路不用停，表达慢慢来。"}
        </h2>
        <div className="feature-grid">
          <TemplateChoiceDemo locale={locale} />
          <SoundDemo locale={locale} />
          <StreamDemo locale={locale} />
          <LanguageDemo locale={locale} />
        </div>
        <div className="feature-pair">
          <IllustratedFeature locale={locale} type="templates" />
          <IllustratedFeature locale={locale} type="hotwords" />
        </div>
      </div>
    </section>
  )
}
