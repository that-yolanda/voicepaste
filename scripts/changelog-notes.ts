// Bilingual changelog extraction for the updater manifest.
//
// Shared by scripts/pack.ts and unit-tested from web/tests/lib/ — keep this
// module free of pack build concerns.

import fs from "node:fs";
import path from "node:path";

/** Extract the `## v<version>` section body from one changelog's content. */
export function extractChangelogSection(content: string, version: string): string {
  const section: string[] = [];
  let inSection = false;

  for (const line of content.split(/\r?\n/)) {
    if (/^##\s/.test(line)) {
      if (inSection) break;
      inSection = (line.match(/^##\s+v?(\S+)/)?.[1] ?? "") === version;
      continue;
    }
    if (inSection) section.push(line);
  }

  return section.join("\n").trim();
}

/**
 * Encode bilingual notes for the updater manifest. The desktop updater only
 * exposes the `notes` string to the app, so both languages are JSON-encoded
 * into it ({"zh": "...", "en": "..."}) and the app picks its language at
 * render time. Returns "" when neither language has content.
 */
export function buildBilingualNotes(zh: string, en: string): string {
  if (!zh && !en) return "";
  return JSON.stringify({ zh, en });
}

/**
 * Read both changelogs' sections for `version` and encode the manifest notes.
 * Missing files or entries only warn — beta builds whose version has no
 * changelog entry intentionally ship an empty note body.
 */
export function readChangelogNotes(version: string): string {
  const read = (fileName: string): string => {
    const filePath = path.join(__dirname, "..", fileName);
    if (!fs.existsSync(filePath)) {
      console.warn(`  Warning: ${fileName} not found.`);
      return "";
    }
    const section = extractChangelogSection(fs.readFileSync(filePath, "utf8"), version);
    if (!section) console.warn(`  Warning: ${fileName} has no entry for v${version}.`);
    return section;
  };

  const notes = buildBilingualNotes(read("CHANGELOG.zh.md"), read("CHANGELOG.md"));
  if (!notes) {
    console.warn(`  Warning: no changelog entry for v${version}; notes will be empty.`);
  }
  return notes;
}
