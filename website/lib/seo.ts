import type { Metadata } from "next"
import faqItems from "./faq.json"
import type { Locale } from "./i18n"
export const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"
export function faqJsonLd(locale: Locale) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqItems.map((item) => ({
      "@type": "Question",
      name: item.question[locale],
      acceptedAnswer: {
        "@type": "Answer",
        text: item.answer[locale],
      },
    })),
  }
}
export function pageMetadata(
  locale: Locale,
  path: string,
  title: string,
  description: string
): Metadata {
  // Shared brand banner, 1280x640 (2:1); platforms that crop to 1.91:1
  // only trim the empty side margins.
  const ogImage =
    locale === "zh" ? "/assets/banner-zh.png" : "/assets/banner-en.png"
  return {
    metadataBase: new URL(siteUrl),
    title,
    description,
    alternates: {
      canonical: `/${locale}${path}`,
      languages: {
        en: `/en${path}`,
        "zh-CN": `/zh${path}`,
        "x-default": `/en${path}`,
      },
    },
    openGraph: {
      title,
      description,
      url: `/${locale}${path}`,
      siteName: "VoicePaste",
      locale: locale === "zh" ? "zh_CN" : "en_US",
      alternateLocale: [locale === "zh" ? "en_US" : "zh_CN"],
      type: "website",
      images: [
        {
          url: ogImage,
          width: 1280,
          height: 640,
          alt: `${title} — VoicePaste`,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [ogImage],
    },
  }
}

export function breadcrumbJsonLd(
  locale: Locale,
  title: string,
  slug: string[]
) {
  // Google requires an item URL on every step except the last, so the
  // API folder is not listed as a step — it has no page of its own.
  const items = [
    {
      name: locale === "zh" ? "首页" : "Home",
      item: `${siteUrl}/${locale}`,
    },
    {
      name: locale === "zh" ? "配置文档" : "Docs",
      item: `${siteUrl}/${locale}/docs`,
    },
    {
      name: title,
      item: `${siteUrl}/${locale}/docs/${slug.join("/")}`,
    },
  ]
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((entry, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: entry.name,
      item: entry.item,
    })),
  }
}
