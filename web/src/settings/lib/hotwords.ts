/**
 * Hotword input parsing utilities.
 *
 * The hotword input field accepts a comma-separated bulk input. Each entry may
 * optionally carry a weight via a `|weight` suffix (e.g. `流式输出|5`), which is
 * preserved verbatim — weight parsing happens in the Rust backend
 * (`parse_hotword_entry`). These helpers only split the bulk input into
 * individual entries and merge them into a word list without duplicates.
 */

/** Split a hotword input string into individual, cleaned entries.
 *
 * Splits on ASCII `,` and full-width `，` so paste from IME input works either
 * way. Each segment is trimmed; empty segments are dropped. A single entry
 * (no commas) returns a one-element array, preserving existing single-word
 * behavior. */
export function parseHotwordInput(input: string): string[] {
  return input
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Merge parsed entries into an existing word list, dropping duplicates.
 *
 * Existing words keep their position; new entries append in input order.
 * De-duplication is exact (case-sensitive) to match how the backend stores and
 * matches hotwords. */
export function mergeHotwords(existing: string[], entries: string[]): string[] {
  const seen = new Set(existing);
  const additions: string[] = [];
  for (const w of entries) {
    if (!seen.has(w)) {
      seen.add(w);
      additions.push(w);
    }
  }
  return [...existing, ...additions];
}
