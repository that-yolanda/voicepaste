import { notFound } from "next/navigation"
import { ViewTransition } from "react"
import { isLocale } from "@/lib/i18n"
import { pageMetadata, siteUrl } from "@/lib/seo"
import { HomeContent } from "@/components/home-content"

const homeCopy = {
  en: {
    title: "Free Open-Source Voice Input for Mac & Windows | VoicePaste",
    description:
      "VoicePaste is a free, open-source voice input tool for macOS and Windows. Dictate, translate, and polish text with your own speech and language models.",
  },
  zh: {
    title: "免费开源的 Mac 与 Windows 语音输入工具 | VoicePaste",
    description:
      "VoicePaste 是免费开源的 macOS 与 Windows 语音输入工具，可将语音转为文字，并用自己的大语言模型翻译、润色与整理。",
  },
} as const

type Props = { params: Promise<{ lang: string }> }
export async function generateMetadata({ params }: Props) {
  const { lang } = await params
  if (!isLocale(lang)) notFound()
  return pageMetadata(
    lang,
    "",
    homeCopy[lang].title,
    homeCopy[lang].description
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
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
    },
    sameAs: ["https://github.com/that-yolanda/voicepaste"],
  }

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />
      <ViewTransition enter="page-fade" exit="page-fade" default="none">
        <HomeContent locale={lang} />
      </ViewTransition>
    </>
  )
}
