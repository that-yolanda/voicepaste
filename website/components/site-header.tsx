"use client"
import Link from "next/link"
import Image from "next/image"
import { usePathname } from "next/navigation"
import { useTheme } from "next-themes"
import { Sun, Moon, Menu } from "lucide-react"
import { useState } from "react"
import { Button, buttonVariants } from "@/components/ui/button"
import { localeCookie, type Locale } from "@/lib/i18n"
export function SiteHeader({ locale }: { locale: Locale }) {
  const [open, setOpen] = useState(false)
  const { setTheme, resolvedTheme } = useTheme()
  const pathname = usePathname()
  const en = locale === "en"
  const other = en ? "zh" : "en"
  const destination = pathname.replace(/^\/(en|zh)(?=\/|$)/, `/${other}`)
  const links = [
    { href: `/${locale}/#features`, text: en ? "Features" : "功能介绍" },
    { href: `/${locale}/docs`, text: en ? "Docs" : "配置文档" },
    { href: `/${locale}/downloads`, text: en ? "Download" : "下载" },
  ]
  return (
    <>
      <a
        className="skip-link"
        href={pathname.includes("/docs") ? "#nd-page" : "#main"}
      >
        {en ? "Skip to content" : "跳至正文"}
      </a>
      <header className="wrap flex min-h-24 items-center justify-between gap-4 max-sm:min-h-20">
        <Link
          className="brand inline-flex shrink-0 items-center gap-2"
          href={`/${locale}`}
        >
          <Image
            className="mark-invert"
            src="/assets/mark.png"
            width="34"
            height="34"
            alt=""
          />
          VoicePaste
        </Link>
        <nav
          className="hidden items-center gap-9 text-sm md:flex"
          aria-label={en ? "Main navigation" : "主导航"}
        >
          {links.map((link) => (
            <Link key={link.href} href={link.href}>
              {link.text}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-1">
          <a
            className={buttonVariants({ variant: "ghost", size: "icon-lg" })}
            href="https://github.com/that-yolanda/voicepaste"
            target="_blank"
            rel="noreferrer"
            aria-label="GitHub"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.86c-2.78.6-3.37-1.18-3.37-1.18-.46-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.89 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.56-1.11-4.56-4.95 0-1.09.39-1.99 1.03-2.69-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.03A9.57 9.57 0 0 1 12 6.81c.85 0 1.71.12 2.51.34 1.91-1.3 2.75-1.03 2.75-1.03.55 1.38.2 2.4.1 2.65.64.7 1.03 1.6 1.03 2.69 0 3.85-2.35 4.69-4.58 4.94.36.31.68.92.68 1.85v2.76c0 .27.18.58.69.48A10 10 0 0 0 12 2Z" />
            </svg>
          </a>
          <Button
            variant="ghost"
            size="icon-lg"
            aria-label={en ? "Toggle light and dark mode" : "切换日夜模式"}
            onClick={() =>
              setTheme(resolvedTheme === "dark" ? "light" : "dark")
            }
          >
            <Sun className="hidden dark:block" />
            <Moon className="dark:hidden" />
          </Button>
          <a
            className="inline-flex size-10 items-center justify-center text-sm font-medium"
            href={destination}
            hrefLang={other}
            onClick={(event) => {
              document.cookie = `${localeCookie}=${other};path=/;max-age=31536000;SameSite=Lax`
              event.currentTarget.href =
                destination + window.location.search + window.location.hash
              setOpen(false)
            }}
            aria-label={en ? "切换为中文" : "Switch to English"}
          >
            {en ? "中文" : "EN"}
          </a>
          <Button
            variant="ghost"
            size="icon-lg"
            className="md:hidden"
            aria-label={en ? "Menu" : "菜单"}
            aria-expanded={open}
            aria-controls="mobile-nav"
            onClick={() => setOpen(!open)}
          >
            <Menu />
          </Button>
        </div>
      </header>
      {open && (
        <nav
          id="mobile-nav"
          className="wrap mb-5 flex flex-col gap-1 rounded-lg bg-muted p-2 text-sm md:hidden"
          aria-label={en ? "Mobile navigation" : "手机导航"}
        >
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="flex min-h-12 items-center rounded-md px-4 hover:bg-background"
              onClick={() => setOpen(false)}
            >
              {link.text}
            </Link>
          ))}
        </nav>
      )}
    </>
  )
}
