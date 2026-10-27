import Link from "next/link"
import Image from "next/image"
import type { Locale } from "@/lib/i18n"
export function SiteFooter({ locale }: { locale: Locale }) {
  const en = locale === "en"
  return (
    <footer className="wrap py-12">
      <div className="flex flex-wrap items-center justify-between gap-7">
        <Link
          className="brand inline-flex items-center gap-2"
          href={`/${locale}`}
        >
          <Image
            className="mark-invert"
            src="/assets/mark.png"
            width="32"
            height="32"
            alt=""
          />
          VoicePaste
        </Link>
        <nav
          className="flex flex-wrap gap-x-7 gap-y-3 text-sm"
          aria-label={en ? "Footer navigation" : "页尾导航"}
        >
          <Link href={`/${locale}/docs`}>
            {en ? "Documentation" : "配置文档"}
          </Link>
          <Link href={`/${locale}/feedback`}>
            {en ? "Feedback" : "用户反馈"}
          </Link>
          <Link href={`/${locale}/docs/privacy`}>
            {en ? "Data & privacy" : "数据与隐私"}
          </Link>
        </nav>
      </div>
      <p className="mt-8 text-sm text-muted-foreground">
        © {new Date().getUTCFullYear()} VoicePaste
      </p>
    </footer>
  )
}
