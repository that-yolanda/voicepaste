import { describe, expect, it } from "vitest";
import { formatPromptHotkey, KEY_DISPLAY_NAMES, normalizeHotkeyLabel } from "@/lib/hotkey";

describe("normalizeHotkeyLabel", () => {
  it("converts Control to ⌃", () => {
    expect(normalizeHotkeyLabel("Control")).toBe("⌃");
  });
  it("converts Ctrl to ⌃", () => {
    expect(normalizeHotkeyLabel("Ctrl")).toBe("⌃");
  });
  it("converts Shift to ⇧", () => {
    expect(normalizeHotkeyLabel("Shift")).toBe("⇧");
  });
  it("converts Alt to ⌥", () => {
    expect(normalizeHotkeyLabel("Alt")).toBe("⌥");
  });
  it("converts Option to ⌥", () => {
    expect(normalizeHotkeyLabel("Option")).toBe("⌥");
  });
  it("converts Cmd to ⌘", () => {
    expect(normalizeHotkeyLabel("Cmd")).toBe("⌘");
  });
  it("converts Meta to ⌘", () => {
    expect(normalizeHotkeyLabel("Meta")).toBe("⌘");
  });
  it("converts Command to ⌘", () => {
    expect(normalizeHotkeyLabel("Command")).toBe("⌘");
  });
  it("converts Space to ␣", () => {
    expect(normalizeHotkeyLabel("Space")).toBe("␣");
  });
  it("converts ControlLeft to L ⌃", () => {
    expect(normalizeHotkeyLabel("ControlLeft")).toBe("L ⌃");
  });
  it("converts ShiftRight to R ⇧", () => {
    expect(normalizeHotkeyLabel("ShiftRight")).toBe("R ⇧");
  });
  it("converts AltLeft to L ⌥", () => {
    expect(normalizeHotkeyLabel("AltLeft")).toBe("L ⌥");
  });
  it("converts AltRight to R ⌥", () => {
    expect(normalizeHotkeyLabel("AltRight")).toBe("R ⌥");
  });
  it("converts MetaLeft to L ⌘", () => {
    expect(normalizeHotkeyLabel("MetaLeft")).toBe("L ⌘");
  });
  it("converts MetaRight to R ⌘", () => {
    expect(normalizeHotkeyLabel("MetaRight")).toBe("R ⌘");
  });
  it("converts CmdOrCtrl to ⌘", () => {
    expect(normalizeHotkeyLabel("CmdOrCtrl")).toBe("⌘");
  });
  it("returns unknown keys as-is", () => {
    expect(normalizeHotkeyLabel("F13")).toBe("F13");
  });
  it("returns empty string as-is", () => {
    expect(normalizeHotkeyLabel("")).toBe("");
  });
});

describe("formatPromptHotkey", () => {
  it("returns empty for non-array", () => {
    expect(formatPromptHotkey(null)).toBe("");
    expect(formatPromptHotkey(undefined)).toBe("");
    expect(formatPromptHotkey("string")).toBe("");
  });
  it("returns empty for empty array", () => {
    expect(formatPromptHotkey([])).toBe("");
  });
  it("joins string format hotkeys", () => {
    expect(formatPromptHotkey(["Control", "Shift", "A"])).toBe("Control + Shift + A");
  });
  it("returns single key without separator", () => {
    expect(formatPromptHotkey(["F13"])).toBe("F13");
  });
});

describe("KEY_DISPLAY_NAMES", () => {
  it("contains common keys", () => {
    expect(KEY_DISPLAY_NAMES[1]).toBe("Esc");
    expect(KEY_DISPLAY_NAMES[57]).toBe("␣");
    expect(KEY_DISPLAY_NAMES[59]).toBe("F1");
    expect(KEY_DISPLAY_NAMES[88]).toBe("F12");
  });
});
