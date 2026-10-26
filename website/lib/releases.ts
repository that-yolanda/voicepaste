import config from "@/config/releases.json"
import type { Locale } from "@/lib/i18n"
export type Platform =
  "macos-arm64" | "macos-x64" | "windows-x64" | "windows-msi"
export type Release = (typeof config.releases)[number]
export const platforms: Platform[] = ["macos-arm64", "macos-x64", "windows-x64"]
export const platformNames: Record<Platform, string> = {
  "macos-arm64": "macOS · Apple Silicon",
  "macos-x64": "macOS · Intel",
  "windows-x64": "Windows · x64",
  "windows-msi": "Windows · MSI",
}
export const latest = config.releases.find(
  (release) => release.version === config.latest
)!
if (!latest)
  throw new Error("The latest release is missing from config/releases.json")
export const githubReleases = config.githubReleases
export const releases = config.releases

export function getReleaseRecords(lang: Locale, version?: string) {
  const normalized = version?.replace(/^v/, "")
  return releases
    .filter(
      (release) =>
        normalized === undefined ||
        release.version.replace(/^v/, "") === normalized
    )
    .map((release) => ({
      version: release.version,
      date: release.date,
      releaseUrl: release.releaseUrl,
      files: release.files,
      notes: release.notes[lang],
    }))
}
export function asset(release: Release, platform: Platform) {
  const file = release.files.find((file) => file.platform === platform)
  if (!file)
    throw new Error(`Missing ${platform} installer for ${release.version}`)
  return file
}
