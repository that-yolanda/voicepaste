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
  description: string,
  opts: { ogBrandImage?: boolean } = {}
): Metadata {
  // Latin-only titles render with the OG route's bundled font; other
  // scripts would draw as tofu, so localized pages keep the brand card.
  const ogImage =
    locale === "en" && !opts.ogBrandImage
      ? `/og?title=${encodeURIComponent(title)}`
      : "/og"
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
          width: 1200,
          height: 630,
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
  const items: { name: string; item?: string }[] = [
    {
      name: locale === "zh" ? "首页" : "Home",
      item: `${siteUrl}/${locale}`,
    },
    {
      name: locale === "zh" ? "配置文档" : "Docs",
      item: `${siteUrl}/${locale}/docs`,
    },
  ]
  if (slug.length > 1 && slug[0] === "api") {
    // The API folder groups provider guides but has no page of its own.
    items.push({ name: locale === "zh" ? "模型 API 申请" : "Model API setup" })
  }
  items.push({
    name: title,
    item: `${siteUrl}/${locale}/docs/${slug.join("/")}`,
  })
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((entry, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: entry.name,
      ...(entry.item ? { item: entry.item } : {}),
    })),
  }
}
