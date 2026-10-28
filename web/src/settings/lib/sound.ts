/**
 * Sound file utilities extracted from settings.js.
 */

import i18next from "i18next";

/** Extract the filename from a file path. Returns the localized "built-in
 *  default" label for empty input. */
export function soundFileName(path: string | null | undefined): string {
  if (!path) return i18next.t("ui.sound.default");
  try {
    return path.split(/[\\/]/).pop() ?? path;
  } catch {
    return path;
  }
}
