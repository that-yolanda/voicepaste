/**
 * Sound file utilities extracted from settings.js.
 */

/** Extract the filename from a file path. Returns "内置默认" for empty input. */
export function soundFileName(path: string | null | undefined): string {
  if (!path) return "内置默认";
  try {
    return path.split(/[\\/]/).pop() ?? path;
  } catch {
    return path;
  }
}
