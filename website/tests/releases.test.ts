import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { NextRequest } from "next/server"
import { GET } from "../app/api/releases/route"
import { releases } from "../lib/releases"
import { extractNotes, syncReleaseNotes } from "../scripts/sync-releases.mjs"

test("every published release preserves its bilingual source Markdown", () => {
  const en = readFileSync(
    new URL("../../CHANGELOG.md", import.meta.url),
    "utf8"
  )
  const zh = readFileSync(
    new URL("../../CHANGELOG.zh.md", import.meta.url),
    "utf8"
  )
  assert.deepEqual(syncReleaseNotes(releases, en, zh), releases)
})

test("sync handles CRLF, beta versions, quotes, backslashes and line breaks", () => {
  const body = 'A "quote", `C:\\path` and **Markdown**.\n\n- A list item'
  const markdown = `# Changelog\r\n\r\n## v3.0.0-beta.1 (2026-10-26)\r\n${body.replaceAll("\n", "\r\n")}\r\n\r\n## v2.9.0 (2026-10-01)\r\nOlder notes\r\n`
  const result = syncReleaseNotes(
    [{ version: "v3.0.0-beta.1", date: "2026-10-27" }],
    markdown,
    markdown
  )
  assert.equal(result[0].notes.en, body)
  assert.equal(JSON.parse(JSON.stringify(result))[0].notes.zh, body)
  assert.equal(result[0].date, "2026-10-27")
})

test("sync rejects duplicate releases, duplicate headings and missing translations", () => {
  const notes = "## v1.0.0 (2026-10-26)\nSome notes\n"
  assert.throws(() => extractNotes(notes + notes), /Duplicate changelog/)
  assert.throws(
    () => extractNotes("## v1.0.0 (2026-10-26)\n\n"),
    /Empty changelog/
  )
  assert.throws(
    () => syncReleaseNotes([{ version: "v1.0.0" }], notes, ""),
    /Missing bilingual/
  )
  assert.throws(
    () =>
      syncReleaseNotes(
        [{ version: "v1.0.0" }, { version: "1.0.0" }],
        notes,
        notes
      ),
    /Duplicate release/
  )
})

test("API returns only the requested release and language, with cache headers", async () => {
  const release = releases[0]
  for (const version of [release.version, release.version.replace(/^v/, "")]) {
    const response = GET(
      new NextRequest(
        `http://localhost/api/releases?version=${version}&lang=zh`
      )
    )
    assert.equal(response.status, 200)
    assert.match(response.headers.get("Cache-Control")!, /max-age=300/)
    assert.deepEqual((await response.json()).releases, [
      {
        version: release.version,
        date: release.date,
        releaseUrl: release.releaseUrl,
        files: release.files,
        notes: release.notes.zh,
      },
    ])
  }
})

test("API defaults to English and reports invalid language or unknown version", async () => {
  const all = GET(new NextRequest("http://localhost/api/releases"))
  const records = (await all.json()).releases
  assert.equal(records.length, releases.length)
  assert.equal(records[0].notes, releases[0].notes.en)
  for (const lang of ["de", ""]) {
    assert.equal(
      GET(new NextRequest(`http://localhost/api/releases?lang=${lang}`)).status,
      400
    )
  }
  for (const version of ["0.0.0", ""]) {
    assert.equal(
      GET(new NextRequest(`http://localhost/api/releases?version=${version}`))
        .status,
      404
    )
  }
})
