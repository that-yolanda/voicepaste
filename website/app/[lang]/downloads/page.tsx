import { notFound } from "next/navigation"
import { ViewTransition } from "react"
import { isLocale } from "@/lib/i18n"
import { pageMetadata } from "@/lib/seo"
import { latest, platforms, releases, githubReleases } from "@/lib/releases"
import { DownloadButton } from "@/components/download-button"
import { ReleaseNotes } from "@/components/release-notes"
import { PlatformIcon } from "@/components/platform-icon"

type Props = { params: Promise<{ lang: string }> }
export async function generateMetadata({ params }: Props) {
  const { lang } = await params
  if (!isLocale(lang)) notFound()
  return pageMetadata(
    lang,
    "/downloads",
    lang === "en" ? "Download & release notes" : "下载与更新日志",
    lang === "en"
      ? "Download VoicePaste for macOS and Windows. Read what's new in each release."
      : "下载适用于 macOS 与 Windows 的 VoicePaste，查看每个版本的新功能、改进与修复。"
  )
}
export default async function Downloads({ params }: Props) {
  const { lang } = await params
  if (!isLocale(lang)) notFound()
  const en = lang === "en"
  return (
    <ViewTransition enter="page-fade" exit="page-fade" default="none">
      <main id="main" className="marketing wrap py-10 md:py-14">
        <div className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-5">
          <h1 className="text-4xl md:text-6xl">
            {en ? "Download VoicePaste" : "下载 VoicePaste"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {latest.version} · <time dateTime={latest.date}>{latest.date}</time>
          </p>
        </div>
        <section
          className="mt-10"
          aria-label={en ? "Download installers" : "下载安装包"}
        >
          <div className="mx-auto grid max-w-4xl gap-4 lg:grid-cols-2">
            <article className="mx-auto flex w-full max-w-md min-w-0 flex-col gap-6 rounded-xl bg-muted p-6">
              <h2 className="flex items-center gap-3 text-2xl tracking-tight [&_svg]:size-6">
                <PlatformIcon platform="macos-arm64" />
                macOS
              </h2>
              <div className="flex flex-wrap justify-center gap-3">
                <DownloadButton
                  platform="macos-arm64"
                  label="Apple Silicon"
                  showSize
                />
                <DownloadButton platform="macos-x64" label="Intel" showSize />
              </div>
            </article>
            <article className="mx-auto flex w-full max-w-md min-w-0 flex-col gap-6 rounded-xl bg-muted p-6">
              <h2 className="flex items-center gap-3 text-2xl tracking-tight [&_svg]:size-6">
                <PlatformIcon platform="windows-x64" />
                Windows
              </h2>
              <div className="flex flex-wrap justify-center gap-3">
                <DownloadButton
                  platform="windows-x64"
                  label="Windows X64 EXE"
                  showSize
                />
                {latest.files.some(
                  (file) => file.platform === "windows-msi"
                ) && (
                  <DownloadButton
                    platform="windows-msi"
                    label="Windows X64 MSI"
                    showSize
                  />
                )}
              </div>
            </article>
          </div>
        </section>
        <section className="mt-16 md:mt-20" aria-labelledby="history-title">
          <div className="mb-10 flex flex-wrap items-baseline justify-between gap-4">
            <h2 id="history-title" className="text-2xl md:text-3xl">
              {en ? "Release notes" : "更新日志"}
            </h2>
            <a
              className="text-sm text-muted-foreground"
              href={githubReleases}
              target="_blank"
              rel="noreferrer"
            >
              {en ? "All releases on GitHub" : "GitHub 全部版本"} ↗
            </a>
          </div>
          <div className="release-timeline">
            {releases.map((release) => {
              const current = release.version === latest.version
              return (
                <details
                  key={release.version}
                  id={release.version}
                  open={current}
                  className="history-release group/release relative pb-10 pl-7 last:pb-0 md:pl-10"
                >
                  <summary className="flex min-h-12 cursor-pointer list-none flex-wrap items-center gap-x-5 gap-y-2 rounded-md py-2 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
                    <h3 className="text-xl md:text-2xl">{release.version}</h3>
                    <time
                      className="text-sm text-muted-foreground tabular-nums"
                      dateTime={release.date}
                    >
                      {release.date}
                    </time>
                    <span
                      className="ml-auto text-sm text-muted-foreground"
                      aria-hidden="true"
                    >
                      <span className="group-open/release:hidden">
                        {en ? "Read notes +" : "展开日志 +"}
                      </span>
                      <span className="hidden group-open/release:inline">
                        {en ? "Close −" : "收起 −"}
                      </span>
                    </span>
                  </summary>
                  <div className="release-body pt-5 md:ml-52">
                    <div className="mb-6 flex flex-wrap gap-3">
                      {platforms
                        .concat("windows-msi")
                        .filter((platform) =>
                          release.files.some(
                            (file) => file.platform === platform
                          )
                        )
                        .map((platform) => (
                          <DownloadButton
                            key={platform}
                            platform={platform}
                            release={release}
                            secondary
                          />
                        ))}
                    </div>
                    <ReleaseNotes>{release.notes[lang]}</ReleaseNotes>
                  </div>
                </details>
              )
            })}
          </div>
        </section>
      </main>
    </ViewTransition>
  )
}
