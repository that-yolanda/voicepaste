import Link from "next/link"
import { notFound } from "next/navigation"
import { ViewTransition } from "react"
import { isLocale } from "@/lib/i18n"
import { pageMetadata } from "@/lib/seo"
import {
  latest,
  history,
  platforms,
  platformNames,
  asset,
  githubReleases,
} from "@/lib/releases"
import { DownloadButton } from "@/components/download-button"
type Props = { params: Promise<{ lang: string }> }
export async function generateMetadata({ params }: Props) {
  const { lang } = await params
  if (!isLocale(lang)) notFound()
  return pageMetadata(
    lang,
    "/downloads",
    lang === "en" ? "Download" : "下载",
    lang === "en"
      ? "Get VoicePaste for Apple Silicon, Intel Macs and Windows. Browse previous releases."
      : "下载适用于 Apple Silicon、Intel Mac 与 Windows 的 VoicePaste，查看历史版本。"
  )
}
export default async function Downloads({ params }: Props) {
  const { lang } = await params
  if (!isLocale(lang)) notFound()
  const en = lang === "en"
  const msi = latest.files.find((f) => f.platform === "windows-msi")
  return (
    <ViewTransition enter="page-fade" exit="page-fade" default="none">
      <main id="main" className="marketing wrap py-12">
        <h1 className="text-display">
          {en ? "Download VoicePaste" : "下载 VoicePaste"}
        </h1>
        <p className="mt-7 max-w-2xl">
          {en
            ? "Free, lightweight and open source. Choose the installer for your computer."
            : "免费、轻量、开源。选择适合你电脑的安装包。"}
        </p>
        <section className="mt-16" aria-labelledby="latest-title">
          <div className="mb-8 flex flex-wrap items-baseline justify-between gap-4">
            <h2 id="latest-title" className="text-head">
              {en ? "Latest release" : "最新版本"}
            </h2>
            <p>
              {latest.version} ·{" "}
              <time dateTime={latest.date}>{latest.date}</time>
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {platforms.map((platform) => {
              const file = asset(latest, platform)
              return (
                <article
                  key={platform}
                  className="flex flex-col items-start gap-6 rounded-xl bg-muted p-7"
                >
                  <h3 className="text-lead">{platformNames[platform]}</h3>
                  <p>
                    {(file.size / 1e6).toFixed(1)} MB · {latest.version}
                  </p>
                  <DownloadButton platform={platform} />
                  {platform === "windows-x64" && msi && (
                    <a
                      className="text-sm underline underline-offset-4"
                      href={msi.url}
                    >
                      {en ? "Download MSI installer" : "下载 MSI 安装包"}
                    </a>
                  )}
                </article>
              )
            })}
          </div>
          <p className="mt-7">
            {en
              ? "On your Mac, open Apple menu → About This Mac to check the chip."
              : "在 Mac 的「苹果菜单 → 关于本机」中查看芯片类型。"}{" "}
            <Link
              className="underline underline-offset-4"
              href={`/${lang}/docs`}
            >
              {en ? "Installation guide" : "安装说明"} ↗
            </Link>
          </p>
        </section>
        <section className="mt-20" aria-labelledby="history-title">
          <div className="mb-8 flex flex-wrap items-baseline justify-between gap-4">
            <h2 id="history-title" className="text-head">
              {en ? "Previous releases" : "历史版本"}
            </h2>
            <a href={githubReleases} target="_blank" rel="noreferrer">
              {en ? "All releases on GitHub" : "GitHub 全部版本"} ↗
            </a>
          </div>
          <div className="flex flex-col gap-3">
            {history.map((release) => (
              <details
                key={release.version}
                className="history-release rounded-xl bg-muted"
              >
                <summary className="flex cursor-pointer items-center justify-between gap-4 p-6">
                  <span>{release.version}</span>
                  <time dateTime={release.date}>{release.date}</time>
                  <span className="history-plus" aria-hidden="true">
                    ＋
                  </span>
                </summary>
                <div className="px-6 pb-6">
                  <div className="grid gap-3 md:grid-cols-3">
                    {platforms.map((platform) => (
                      <DownloadButton
                        key={platform}
                        platform={platform}
                        release={release}
                        secondary
                      />
                    ))}
                  </div>
                  <a
                    className="mt-5 inline-block text-sm underline underline-offset-4"
                    href={release.releaseUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {en ? "Release notes" : "更新说明"} ↗
                  </a>
                </div>
              </details>
            ))}
          </div>
        </section>
      </main>
    </ViewTransition>
  )
}
