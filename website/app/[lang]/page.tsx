import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { ViewTransition } from "react"
import { isLocale } from "@/lib/i18n"
import { latest } from "@/lib/releases"
import { faqJsonLd, pageMetadata, siteUrl } from "@/lib/seo"
import { HomeContent } from "@/components/home-content"

const homeCopy = {
  en: {
    title: "Free Open-Source Voice Input for Mac & Windows | VoicePaste",
    description:
      "VoicePaste is a free, open-source voice input tool for macOS and Windows. Dictate, translate, and polish text with your own speech and language models.",
    features: [
      "Global-shortcut voice input in any app",
      "Online or local speech recognition, including offline models",
      "Translation and polishing with your own language model",
      "Hotwords for names, products, and technical terms",
      "Free and open source",
    ],
  },
  zh: {
    title: "免费开源的 Mac 与 Windows 语音输入工具 | VoicePaste",
    description:
      "VoicePaste 是免费开源的 macOS 与 Windows 语音输入工具，可将语音转为文字，并用自己的大语言模型翻译、润色与整理。",
    features: [
      "全局快捷键在任意应用内语音输入",
      "在线或本地语音识别，支持完全离线",
      "用自己的大语言模型翻译与润色",
      "人名、产品名与技术术语热词优化",
      "免费开源",
    ],
  },
} as const

type Props = { params: Promise<{ lang: string }> }
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { lang } = await params
  if (!isLocale(lang)) notFound()
  return pageMetadata(
    lang,
    "",
    homeCopy[lang].title,
    homeCopy[lang].description,
    { ogBrandImage: true }
  )
}
export default async function Home({ params }: Props) {
  const { lang } = await params
  if (!isLocale(lang)) notFound()
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "VoicePaste",
    url: new URL(`/${lang}`, siteUrl).toString(),
    description: homeCopy[lang].description,
    inLanguage: lang === "zh" ? "zh-CN" : "en",
    operatingSystem: "macOS, Windows",
    applicationCategory: "UtilitiesApplication",
    isAccessibleForFree: true,
    softwareVersion: latest.version.replace(/^v/, ""),
    dateModified: latest.date,
    downloadUrl: `${siteUrl}/${lang}/downloads`,
    featureList: homeCopy[lang].features,
    screenshot: `${siteUrl}/assets/demo-${lang}-poster.jpg`,
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
    },
    author: {
      "@type": "Organization",
      name: "VoicePaste",
      url: siteUrl,
      logo: `${siteUrl}/favicon.ico`,
      sameAs: ["https://github.com/that-yolanda/voicepaste"],
    },
    sameAs: ["https://github.com/that-yolanda/voicepaste"],
  }

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(faqJsonLd(lang)),
        }}
      />
      <ViewTransition enter="page-fade" exit="page-fade" default="none">
        <HomeContent locale={lang} />
      </ViewTransition>
    </>
  )
}
