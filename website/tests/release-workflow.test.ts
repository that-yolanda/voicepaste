import { strict as assert } from "node:assert"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import config from "../config/releases.json"
import {
  checkWebsiteRelease,
  syncWebsiteRelease,
  type GitHubRelease,
} from "../../.claude/skills/github-release/scripts/sync-website-release.mjs"

const english = readFileSync(
  new URL("../../CHANGELOG.md", import.meta.url),
  "utf8"
)
const chinese = readFileSync(
  new URL("../../CHANGELOG.zh.md", import.meta.url),
  "utf8"
)
const base = "https://github.com/that-yolanda/voicepaste/releases"
const scripts = fileURLToPath(
  new URL("../../.claude/skills/github-release/scripts/", import.meta.url)
)

function fixture(version = "2.1.6"): GitHubRelease {
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: version.includes("-"),
    published_at: "2026-10-27T01:02:03Z",
    html_url: `${base}/tag/v${version}`,
    assets: ["aarch64.dmg", "x64.dmg", "x64-setup.exe", "x64_en-US.msi"].map(
      (suffix, index) => ({
        name: `VoicePaste_${version}_${suffix}`,
        size: 1000 + index,
        state: "uploaded",
        browser_download_url: `${base}/download/v${version}/VoicePaste_${version}_${suffix}`,
      })
    ),
  }
}
function notes(version: string) {
  return {
    en: `## v${version} (2026-10-26)\nA "quoted" update.\n\n- **Improved** output.\n\n${english}`,
    zh: `## v${version} (2026-10-26)\n中文更新。\n\n${chinese}`,
  }
}

test("stable synchronization inserts once using remote assets and publication date", () => {
  const source = notes("2.1.6")
  const output = syncWebsiteRelease(
    config,
    fixture(),
    "v2.1.6",
    source.en,
    source.zh
  )
  assert.equal(output.latest, "v2.1.6")
  assert.equal(output.releases[0].date, "2026-10-27")
  assert.equal(output.releases[0].files[2].size, 1002)
  assert.match(output.releases[0].notes.en, /A "quoted" update/)
  assert.deepEqual(
    syncWebsiteRelease(output, fixture(), "2.1.6", source.en, source.zh),
    output
  )
  assert.equal(config.latest, "v2.1.5")
})

test("beta synchronization preserves the stable default and first timeline entry", () => {
  const version = "2.1.6-beta"
  const source = notes(version)
  const output = syncWebsiteRelease(
    config,
    fixture(version),
    version,
    source.en,
    source.zh
  )
  assert.equal(output.latest, config.latest)
  assert.equal(output.releases[0].version, config.latest)
  assert.equal(output.releases[1].version, `v${version}`)
  checkWebsiteRelease(output, version, source.en, source.zh)
})

test("sync rejects draft, wrong tag, incomplete assets and missing source notes", () => {
  const source = notes("2.1.6")
  for (const release of [
    { ...fixture(), draft: true },
    { ...fixture(), tag_name: "v2.1.60" },
    { ...fixture(), prerelease: true },
    { ...fixture(), published_at: null },
    { ...fixture(), assets: fixture().assets.slice(1) },
    { ...fixture(), assets: [...fixture().assets, fixture().assets[0]] },
    {
      ...fixture(),
      assets: fixture().assets.map((asset) => ({ ...asset, size: 0 })),
    },
    {
      ...fixture(),
      assets: fixture().assets.map((asset) => ({
        ...asset,
        browser_download_url: "https://example.com/wrong",
      })),
    },
  ]) {
    assert.throws(() =>
      syncWebsiteRelease(config, release, "2.1.6", source.en, source.zh)
    )
  }
  assert.throws(
    () => syncWebsiteRelease(config, fixture(), "2.1.6", source.en, chinese),
    /Missing bilingual/
  )
})

test("target gate catches a new version omitted from an otherwise valid config", () => {
  assert.throws(
    () =>
      syncWebsiteRelease(config, fixture("2.1.4"), "2.1.4", english, chinese),
    /older stable release/
  )
  checkWebsiteRelease(config, "2.1.5", english, chinese)
  assert.throws(
    () => checkWebsiteRelease(config, "2.1.6", english, chinese),
    /Website release is missing/
  )
  const stale = structuredClone(config)
  stale.releases[0].notes.zh = "stale"
  assert.throws(
    () => checkWebsiteRelease(stale, "2.1.5", english, chinese),
    /out of sync/
  )
  const wrongLatest = { ...config, latest: "v2.1.4" }
  assert.throws(
    () => checkWebsiteRelease(wrongLatest, "2.1.5", english, chinese),
    /latest does not match/
  )
})

function temporaryRepo() {
  const directory = mkdtempSync(join(tmpdir(), "voicepaste-release-workflow-"))
  execFileSync("git", ["init", "-q", directory])
  return directory
}

test("release rendering matches an exact stable/beta heading and preserves paragraphs", () => {
  const cwd = temporaryRepo()
  writeFileSync(
    join(cwd, "CHANGELOG.md"),
    [
      "## v2.1.50 (2026-10-28)\nWrong prefix entry.",
      "## v2.1.5-beta (2026-10-27)\nBeta only.",
      "## v2.1.5 (2026-10-26)\nStable paragraph.\n\nSecond paragraph.",
      "## v2.1.4 (2026-10-25)\nOld entry.",
    ].join("\n\n")
  )
  const render = (version: string) =>
    execFileSync(
      "bash",
      [join(scripts, "render-release-notes.sh"), version, "2.1.4"],
      { cwd, encoding: "utf8" }
    )
  const stable = render("v2.1.5")
  assert.match(stable, /Stable paragraph\.\n\nSecond paragraph\./)
  assert.doesNotMatch(stable, /Wrong prefix entry|Beta only|Old entry/)
  assert.match(render("2.1.5-beta"), /Beta only/)
  assert.notEqual(
    spawnSync(
      "bash",
      [join(scripts, "render-release-notes.sh"), "2.1.6", "2.1.4"],
      { cwd }
    ).status,
    0
  )
})

test("artifact collection accepts beta flags and infers the beta manifest from the version", () => {
  const cwd = temporaryRepo()
  const dist = join(cwd, "dist")
  mkdirSync(dist)
  writeFileSync(join(dist, "VoicePaste_2.1.6-beta_aarch64.dmg"), "installer")
  writeFileSync(join(dist, "latest-beta.json"), "{}")
  for (const flags of [[], ["--beta"]]) {
    const result = spawnSync(
      "bash",
      [
        join(scripts, "collect-release-artifacts.sh"),
        "v2.1.6-beta",
        ...flags,
        "--platforms",
        "apple_aarch64",
      ],
      { cwd, encoding: "utf8" }
    )
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /latest-beta.json/)
    assert.doesNotMatch(result.stdout, /\/latest.json/)
  }
  for (const args of [
    ["2.1.6", "--beta"],
    ["2.1.6", "--platforms"],
  ]) {
    assert.notEqual(
      spawnSync(
        "bash",
        [join(scripts, "collect-release-artifacts.sh"), ...args],
        { cwd }
      ).status,
      0
    )
  }
})
