/**
 * Hotkey display utilities extracted from settings.js.
 */

/** Map raw key names to their display symbols. */
export function normalizeHotkeyLabel(key: string): string {
  const aliases: Record<string, string> = {
    CmdOrCtrl: "⌘",
    CommandOrControl: "⌘",
    Command: "⌘",
    Cmd: "⌘",
    Meta: "⌘",
    Control: "⌃",
    Ctrl: "⌃",
    Shift: "⇧",
    Alt: "⌥",
    Option: "⌥",
    Space: "␣",
    ControlLeft: "L ⌃",
    ControlRight: "R ⌃",
    ShiftLeft: "L ⇧",
    ShiftRight: "R ⇧",
    AltLeft: "L ⌥",
    AltRight: "R ⌥",
    MetaLeft: "L ⌘",
    MetaRight: "R ⌘",
  };
  return aliases[key] || key;
}

/** Key code → display name map (legacy uIOhook format). */
export const KEY_DISPLAY_NAMES: Record<number, string> = {
  1: "Esc",
  14: "Backspace",
  15: "Tab",
  28: "Enter",
  29: "L ⌃",
  42: "L ⇧",
  54: "R ⇧",
  56: "L ⌥",
  57: "␣",
  3613: "R ⌃",
  3640: "R ⌥",
  3675: "L ⌘",
  3676: "R ⌘",
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
 * human-readable string like "Ctrl + Shift + A".
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
