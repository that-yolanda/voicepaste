import { describe, expect, it } from "vitest";
import {
  formatPromptHotkey,
  KEY_DISPLAY_NAMES,
  normalizeHotkeyLabel,
  normalizeHotkeyToken,
} from "@/settings/lib/hotkey";

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
  it("maps modifier keycodes to physical key names", () => {
    expect(KEY_DISPLAY_NAMES[29]).toBe("ControlLeft");
    expect(KEY_DISPLAY_NAMES[56]).toBe("AltLeft");
    expect(KEY_DISPLAY_NAMES[3675]).toBe("MetaLeft");
  });
});

describe("normalizeHotkeyLabel (Windows)", () => {
  it("converts Control/Ctrl to Ctrl", () => {
    expect(normalizeHotkeyLabel("Control", false)).toBe("Ctrl");
    expect(normalizeHotkeyLabel("Ctrl", false)).toBe("Ctrl");
  });
  it("converts Shift to Shift", () => {
    expect(normalizeHotkeyLabel("Shift", false)).toBe("Shift");
  });
  it("converts Alt/Option to Alt", () => {
    expect(normalizeHotkeyLabel("Alt", false)).toBe("Alt");
    expect(normalizeHotkeyLabel("Option", false)).toBe("Alt");
  });
  it("resolves CmdOrCtrl to Ctrl on Windows", () => {
    expect(normalizeHotkeyLabel("CmdOrCtrl", false)).toBe("Ctrl");
  });
  it("maps the physical Meta key to the Win label", () => {
    expect(normalizeHotkeyLabel("MetaLeft", false)).toBe("L Win");
    expect(normalizeHotkeyLabel("MetaRight", false)).toBe("R Win");
  });
  it("keeps sided modifiers with L/R prefix", () => {
    expect(normalizeHotkeyLabel("ControlLeft", false)).toBe("L Ctrl");
    expect(normalizeHotkeyLabel("AltRight", false)).toBe("R Alt");
    expect(normalizeHotkeyLabel("ShiftLeft", false)).toBe("L Shift");
  });
  it("keeps Space identical", () => {
    expect(normalizeHotkeyLabel("Space", false)).toBe("␣");
  });
  it("returns unknown keys as-is", () => {
    expect(normalizeHotkeyLabel("F13", false)).toBe("F13");
  });
});

describe("normalizeHotkeyToken", () => {
  it("splits ControlLeft into main symbol + L side on macOS", () => {
    expect(normalizeHotkeyToken("ControlLeft")).toEqual({ main: "⌃", side: "L" });
  });
  it("splits AltRight into main symbol + R side on macOS", () => {
    expect(normalizeHotkeyToken("AltRight")).toEqual({ main: "⌥", side: "R" });
  });
  it("splits MetaLeft into Win label + L side on Windows", () => {
    expect(normalizeHotkeyToken("MetaLeft", false)).toEqual({ main: "Win", side: "L" });
  });
  it("splits ShiftRight into Shift label + R side on Windows", () => {
    expect(normalizeHotkeyToken("ShiftRight", false)).toEqual({ main: "Shift", side: "R" });
  });
  it("returns no side for unsided keys", () => {
    expect(normalizeHotkeyToken("CmdOrCtrl")).toEqual({ main: "⌘" });
    expect(normalizeHotkeyToken("F13")).toEqual({ main: "F13" });
  });
  it("trims surrounding whitespace", () => {
    expect(normalizeHotkeyToken(" ControlLeft ")).toEqual({ main: "⌃", side: "L" });
  });
});
