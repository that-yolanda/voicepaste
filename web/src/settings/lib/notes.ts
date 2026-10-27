/**
 * Localized release-notes selection.
 *
 * `latest.json` carries a JSON-encoded bilingual payload in its `notes`
 * field — `"{\"zh\": \"…\", \"en\": \"…\"}"` — because the desktop updater
 * only exposes that single string to the app. Older or hand-written
 * manifests may ship plain Markdown; those are returned untouched.
 */

const NOTE_LANGUAGES = ["zh", "en"] as const;

/**
 * Pick the notes for `language` from a raw manifest `notes` string, falling
 * back to the other supported language, then to the raw string when it is
 * not JSON at all. Returns "" when the payload is JSON but carries no
 * usable language entry.
 */
export function pickNotesLanguage(raw: string, language: (typeof NOTE_LANGUAGES)[number]): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw; // Plain Markdown manifest — display as-is.
  }

  if (parsed === null || typeof parsed !== "object") return "";

  const entries = parsed as Record<string, unknown>;
  for (const code of [language, ...NOTE_LANGUAGES.filter((c) => c !== language)]) {
    const value = entries[code];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return "";
}
