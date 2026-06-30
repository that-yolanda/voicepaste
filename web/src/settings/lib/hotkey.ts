/**
 * Hotkey display utilities extracted from settings.js.
 *
 * The backend records platform-agnostic physical key names
 * ("ControlLeft", "AltLeft", "MetaLeft", ...). We render them per OS: macOS uses
 * Apple symbols (⌃ ⇧ ⌥ ⌘), Windows uses its native labels (Ctrl / Shift / Alt /
 * Win). Callers pass `isMac` so the same recorded string displays correctly on
 * each platform.
 */

/** Alias entry: `[macSymbol, winLabel]`. The semantic Command / CmdOrCtrl tokens
 * resolve to Ctrl on Windows (matching the accelerator convention), while the
 * physical Meta* keys are the Windows logo key. */
const HOTKEY_ALIASES: Record<string, readonly [string, string]> = {
  CmdOrCtrl: ["⌘", "Ctrl"],
  CommandOrControl: ["⌘", "Ctrl"],
  Command: ["⌘", "Ctrl"],
  Cmd: ["⌘", "Ctrl"],
  Meta: ["⌘", "Ctrl"],
  Control: ["⌃", "Ctrl"],
  Ctrl: ["⌃", "Ctrl"],
  Shift: ["⇧", "Shift"],
  Alt: ["⌥", "Alt"],
  Option: ["⌥", "Alt"],
  Space: ["␣", "␣"],
  ControlLeft: ["L ⌃", "L Ctrl"],
  ControlRight: ["R ⌃", "R Ctrl"],
  ShiftLeft: ["L ⇧", "L Shift"],
  ShiftRight: ["R ⇧", "R Shift"],
  AltLeft: ["L ⌥", "L Alt"],
  AltRight: ["R ⌥", "R Alt"],
  MetaLeft: ["L ⌘", "L Win"],
  MetaRight: ["R ⌘", "R Win"],
};

/** Map a raw key name to its display symbol for the given platform. Defaults to
 * macOS symbols to preserve prior behavior for callers that omit the platform. */
export function normalizeHotkeyLabel(key: string, isMac = true): string {
  const entry = HOTKEY_ALIASES[key];
  if (!entry) return key;
  return isMac ? entry[0] : entry[1];
}

/** A hotkey token split into a main key cap and an optional left/right side
 * badge, e.g. ControlLeft -> { main: "⌃", side: "L" }. */
export interface HotkeyToken {
  main: string;
  side?: string;
}

/** Physical left/right modifier keys: `[mainSymbol@mac, mainLabel@win]`. The
 * L/R side badge is derived from the Left/Right suffix of the key name. */
const SIDED_MODIFIERS: Record<string, readonly [string, string]> = {
  ControlLeft: ["⌃", "Ctrl"],
  ControlRight: ["⌃", "Ctrl"],
  ShiftLeft: ["⇧", "Shift"],
  ShiftRight: ["⇧", "Shift"],
  AltLeft: ["⌥", "Alt"],
  AltRight: ["⌥", "Alt"],
  MetaLeft: ["⌘", "Win"],
  MetaRight: ["⌘", "Win"],
};

/** Normalize one hotkey token into a main cap label plus an optional L/R side
 * badge for the KeyCap's top-right corner. Trims surrounding whitespace so both
 * "ControlLeft" and " ControlLeft " (from " + "-joined strings) resolve. */
export function normalizeHotkeyToken(key: string, isMac = true): HotkeyToken {
  const trimmed = key.trim();
  const sided = SIDED_MODIFIERS[trimmed];
  if (sided) {
    return {
      main: isMac ? sided[0] : sided[1],
      side: trimmed.endsWith("Left") ? "L" : "R",
    };
  }
  return { main: normalizeHotkeyLabel(trimmed, isMac) };
}

/**
 * Format a prompt hotkey (array of physical key name strings, e.g.
 * ["Control", "Shift", "A"]) into a " + "-joined display string. Non-string
 * entries are dropped (defensive against malformed stored data).
 */
export function formatPromptHotkey(hotkey: unknown): string {
  if (!Array.isArray(hotkey) || hotkey.length === 0) return "";
  return hotkey.filter((key): key is string => typeof key === "string").join(" + ");
}
