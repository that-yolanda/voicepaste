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

/** Key code → display name map (legacy uIOhook format). Modifier codes map to
 * physical key names so they flow through `normalizeHotkeyLabel` and pick up the
 * correct per-platform symbol. */
export const KEY_DISPLAY_NAMES: Record<number, string> = {
  1: "Esc",
  14: "Backspace",
  15: "Tab",
  28: "Enter",
  29: "ControlLeft",
  42: "ShiftLeft",
  54: "ShiftRight",
  56: "AltLeft",
  57: "␣",
  3613: "ControlRight",
  3640: "AltRight",
  3675: "MetaLeft",
  3676: "MetaRight",
  16: "Q",
  17: "W",
  18: "E",
  19: "R",
  20: "T",
  21: "Y",
  22: "U",
  23: "I",
  24: "O",
  25: "P",
  30: "A",
  31: "S",
  32: "D",
  33: "F",
  34: "G",
  35: "H",
  36: "J",
  37: "K",
  38: "L",
  44: "Z",
  45: "X",
  46: "C",
  47: "V",
  48: "B",
  49: "N",
  50: "M",
  59: "F1",
  60: "F2",
  61: "F3",
  62: "F4",
  63: "F5",
  64: "F6",
  65: "F7",
  66: "F8",
  67: "F9",
  68: "F10",
  87: "F11",
  88: "F12",
  91: "F13",
  92: "F14",
  93: "F15",
  99: "F16",
  100: "F17",
  101: "F18",
  102: "F19",
  103: "F20",
  104: "F21",
  105: "F22",
  106: "F23",
  107: "F24",
  57416: "↑",
  57424: "↓",
  57419: "←",
  57421: "→",
};

/**
 * Format a prompt hotkey (array of strings or legacy keycode numbers) into a
 * "+ "-joined token string. Modifier keycodes resolve to physical key names
 * (e.g. "ControlLeft"); pass each token through `normalizeHotkeyLabel` to apply
 * the per-platform symbol.
 */
export function formatPromptHotkey(hotkey: unknown): string {
  if (!Array.isArray(hotkey) || hotkey.length === 0) return "";
  return hotkey
    .map((key: string | number) => {
      if (typeof key === "string") return key;
      return KEY_DISPLAY_NAMES[key] || `Key(${key})`;
    })
    .join(" + ");
}
