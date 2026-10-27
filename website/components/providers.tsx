"use client"
import { RootProvider } from "fumadocs-ui/provider/next"
import { i18nProvider } from "fumadocs-ui/i18n"
import { translations } from "@/lib/docs-i18n"
import { Toaster } from "@/components/ui/sonner"
import { feedbackCopy } from "@/lib/feedback-copy"
import type { Locale } from "@/lib/i18n"
export function Providers({
  children,
  locale,
}: {
  children: React.ReactNode
  locale: Locale
}) {
  return (
    <RootProvider
      theme={{
        defaultTheme: "dark",
        enableSystem: false,
        storageKey: "voicepaste-theme",
        hotKey: false,
      }}
      i18n={i18nProvider(translations, locale)}
    >
      {children}
      <Toaster
        position="top-center"
        closeButton
        containerAriaLabel={feedbackCopy[locale].notifications}
        toastOptions={{
          closeButtonAriaLabel: feedbackCopy[locale].closeNotification,
        }}
      />
    </RootProvider>
  )
}
