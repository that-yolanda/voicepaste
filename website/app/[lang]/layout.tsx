import type { Metadata } from "next"
import { notFound } from "next/navigation"
import "../globals.css"
import { isLocale, locales } from "@/lib/i18n"
import { siteUrl } from "@/lib/seo"
import { Providers } from "@/components/providers"
import { SiteHeader } from "@/components/site-header"
import { SiteFooter } from "@/components/site-footer"
export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "VoicePaste — Think freely. Speak naturally.",
    template: "%s | VoicePaste",
  },
}
export function generateStaticParams() {
  return locales.map((lang) => ({ lang }))
}
export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ lang: string }>
}) {
  const { lang } = await params
  if (!isLocale(lang)) notFound()
  return (
    <html lang={lang === "zh" ? "zh-CN" : "en"} suppressHydrationWarning>
      <body>
        <Providers locale={lang}>
          <SiteHeader locale={lang} />
          {children}
          <SiteFooter locale={lang} />
        </Providers>
      </body>
    </html>
  )
}
