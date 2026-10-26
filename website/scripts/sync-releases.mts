import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { resolve } from "node:path"

export function extractNotes(markdown: string) {
  const notes = new Map<string, string>()
  for (const section of markdown
    .replace(/\r\n/g, "\n")
    .split(/^## /m)
    .slice(1)) {
    const match = section.match(
      /^(v?\d+\.\d+\.\d+(?:-[\w.-]+)?)[^\n]*\n([\s\S]*)$/
    )
    if (!match) continue
    const version = match[1].replace(/^v/, "")
    const body = match[2].trim()
    if (notes.has(version))
      throw new Error(`Duplicate changelog version: ${version}`)
    if (!body) throw new Error(`Empty changelog notes: ${version}`)
    notes.set(version, body)
  }
  return notes
}

export function syncReleaseNotes<T extends { version: string }>(
  releases: T[],
  english: string,
  chinese: string
) {
  const en = extractNotes(english)
  const zh = extractNotes(chinese)
  const seen = new Set<string>()
  return releases.map((release) => {
    const version = release.version.replace(/^v/, "")
    if (seen.has(version))
      throw new Error(`Duplicate release version: ${version}`)
    seen.add(version)
    const englishNotes = en.get(version)
    const chineseNotes = zh.get(version)
    if (!englishNotes || !chineseNotes)
      throw new Error(`Missing bilingual changelog notes: ${release.version}`)
    return { ...release, notes: { en: englishNotes, zh: chineseNotes } }
  })
}

function main() {
  const configUrl = new URL("../config/releases.json", import.meta.url)
  const original = readFileSync(configUrl, "utf8")
  const config = JSON.parse(original)
  config.releases = syncReleaseNotes(
    config.releases,
    readFileSync(new URL("../../CHANGELOG.md", import.meta.url), "utf8"),
    readFileSync(new URL("../../CHANGELOG.zh.md", import.meta.url), "utf8")
  )
  if (
    !config.releases.some(
      (release: { version: string }) => release.version === config.latest
    )
  )
    throw new Error("The latest release is missing from config/releases.json")
  const output = `${JSON.stringify(config, null, 2)}\n`
  if (process.argv.includes("--check")) {
    if (original !== output)
      throw new Error(
        "Release notes are out of sync. Run pnpm --dir website releases:sync"
      )
    console.log("Release notes match both changelogs.")
  } else {
    writeFileSync(configUrl, output)
    console.log(
      `Synced bilingual notes for ${config.releases.length} releases.`
    )
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main()
