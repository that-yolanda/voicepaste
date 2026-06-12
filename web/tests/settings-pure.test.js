import { describe, expect, it } from "vitest";
import "./helpers/setup-settings.js";
import fs from "node:fs";
import vm from "node:vm";

// Read settings.js and execute it in a mocked environment.
// The setup-settings.js file provides safe mock DOM elements via a patched
// document.getElementById, so the IIFE won't crash on missing elements.
const source = fs.readFileSync("./web/settings.js", "utf-8");

// Set up CommonJS-style module for the test-only module.exports block.
const mod = { exports: {} };
// Set NODE_ENV on the real process (available in Node.js)
process.env.NODE_ENV = "test";
globalThis.module = mod;

vm.runInThisContext(source);

const ex = mod.exports;

describe("normalizeHotkeyLabel", () => {
  it("converts Control to ⌃", () => {
    expect(ex.normalizeHotkeyLabel("Control")).toBe("⌃");
  });

  it("converts Ctrl to ⌃", () => {
    expect(ex.normalizeHotkeyLabel("Ctrl")).toBe("⌃");
  });

  it("converts Shift to ⇧", () => {
    expect(ex.normalizeHotkeyLabel("Shift")).toBe("⇧");
  });

  it("converts Alt to ⌥", () => {
    expect(ex.normalizeHotkeyLabel("Alt")).toBe("⌥");
  });

  it("converts Option to ⌥", () => {
    expect(ex.normalizeHotkeyLabel("Option")).toBe("⌥");
  });

  it("converts Cmd to ⌘", () => {
    expect(ex.normalizeHotkeyLabel("Cmd")).toBe("⌘");
  });

  it("converts Meta to ⌘", () => {
    expect(ex.normalizeHotkeyLabel("Meta")).toBe("⌘");
  });

  it("converts Command to ⌘", () => {
    expect(ex.normalizeHotkeyLabel("Command")).toBe("⌘");
  });

  it("converts Space to ␣", () => {
    expect(ex.normalizeHotkeyLabel("Space")).toBe("␣");
  });

  it("converts ControlLeft to L ⌃", () => {
    expect(ex.normalizeHotkeyLabel("ControlLeft")).toBe("L ⌃");
  });

  it("converts ShiftRight to R ⇧", () => {
    expect(ex.normalizeHotkeyLabel("ShiftRight")).toBe("R ⇧");
  });

  it("converts AltLeft to L ⌥", () => {
    expect(ex.normalizeHotkeyLabel("AltLeft")).toBe("L ⌥");
  });

  it("converts AltRight to R ⌥", () => {
    expect(ex.normalizeHotkeyLabel("AltRight")).toBe("R ⌥");
  });

  it("converts MetaLeft to L ⌘", () => {
    expect(ex.normalizeHotkeyLabel("MetaLeft")).toBe("L ⌘");
  });

  it("converts MetaRight to R ⌘", () => {
    expect(ex.normalizeHotkeyLabel("MetaRight")).toBe("R ⌘");
  });

  it("converts CmdOrCtrl to ⌘", () => {
    expect(ex.normalizeHotkeyLabel("CmdOrCtrl")).toBe("⌘");
  });

  it("returns unknown keys as-is", () => {
    expect(ex.normalizeHotkeyLabel("F13")).toBe("F13");
  });

  it("returns empty string as-is", () => {
    expect(ex.normalizeHotkeyLabel("")).toBe("");
  });
});

describe("formatPromptHotkey", () => {
  it("returns empty for non-array", () => {
    expect(ex.formatPromptHotkey(null)).toBe("");
    expect(ex.formatPromptHotkey(undefined)).toBe("");
    expect(ex.formatPromptHotkey("string")).toBe("");
  });

  it("returns empty for empty array", () => {
    expect(ex.formatPromptHotkey([])).toBe("");
  });

  it("joins string format hotkeys", () => {
    expect(ex.formatPromptHotkey(["Control", "Shift", "A"])).toBe("Control + Shift + A");
  });

  it("returns single key without separator", () => {
    expect(ex.formatPromptHotkey(["F13"])).toBe("F13");
  });
});

describe("formatCompact", () => {
  it("formats numbers < 1000 as-is", () => {
    expect(ex.formatCompact(0)).toBe("0");
    expect(ex.formatCompact(42)).toBe("42");
    expect(ex.formatCompact(999)).toBe("999");
  });

  it("formats thousands with K suffix", () => {
    expect(ex.formatCompact(1000)).toBe("1.0K");
    expect(ex.formatCompact(1500)).toBe("1.5K");
    expect(ex.formatCompact(9999)).toBe("10.0K");
  });

  it("formats millions with M suffix", () => {
    expect(ex.formatCompact(1_000_000)).toBe("1.0M");
    expect(ex.formatCompact(2_500_000)).toBe("2.5M");
  });
});

describe("formatDuration", () => {
  it("formats seconds", () => {
    expect(ex.formatDuration(0)).toBe("0s");
    expect(ex.formatDuration(30)).toBe("30s");
    expect(ex.formatDuration(59)).toBe("59s");
  });

  it("formats minutes", () => {
    expect(ex.formatDuration(60)).toBe("1m");
    expect(ex.formatDuration(90)).toBe("1m");
    expect(ex.formatDuration(120)).toBe("2m");
    expect(ex.formatDuration(3599)).toBe("59m");
  });

  it("formats hours with decimal", () => {
    expect(ex.formatDuration(3600)).toBe("1.0h");
    expect(ex.formatDuration(5400)).toBe("1.5h");
    expect(ex.formatDuration(7200)).toBe("2.0h");
  });

  it("formats >= 10 hours as integer", () => {
    expect(ex.formatDuration(36000)).toBe("10h");
    expect(ex.formatDuration(72000)).toBe("20h");
  });
});

describe("escapeHtml", () => {
  it("escapes ampersand", () => {
    expect(ex.escapeHtml("a & b")).toBe("a &amp; b");
  });

  it("escapes less than", () => {
    expect(ex.escapeHtml("<script>")).toBe("&lt;script&gt;");
  });

  it("escapes greater than", () => {
    expect(ex.escapeHtml("5 > 3")).toBe("5 &gt; 3");
  });

  it("escapes double quote", () => {
    expect(ex.escapeHtml('"hello"')).toBe("&quot;hello&quot;");
  });

  it("escapes all special chars together", () => {
    expect(ex.escapeHtml('<a href="url">&</a>')).toBe(
      "&lt;a href=&quot;url&quot;&gt;&amp;&lt;/a&gt;",
    );
  });

  it("returns empty string unchanged", () => {
    expect(ex.escapeHtml("")).toBe("");
  });
});

describe("clonePlain", () => {
  it("deep clones a plain object", () => {
    const obj = { a: 1, b: { c: 2 } };
    const cloned = ex.clonePlain(obj);
    expect(cloned).toEqual(obj);
    expect(cloned).not.toBe(obj);
    expect(cloned.b).not.toBe(obj.b);
  });

  it("returns empty object for null/undefined", () => {
    expect(ex.clonePlain(null)).toEqual({});
    expect(ex.clonePlain(undefined)).toEqual({});
  });

  it("handles arrays", () => {
    expect(ex.clonePlain([1, 2, 3])).toEqual([1, 2, 3]);
  });
});

describe("getAsrProvider", () => {
  it("returns doubao-streaming by default", () => {
    expect(ex.getAsrProvider({})).toBe("doubao-streaming");
  });

  it("returns configured provider", () => {
    expect(ex.getAsrProvider({ audio: { provider: "sherpa-onnx" } })).toBe("sherpa-onnx");
  });
});

describe("ensureModelConfig", () => {
  it("creates audio section if missing", () => {
    const config = {};
    const result = ex.ensureModelConfig(config, "test-model");
    expect(config.audio).toBeDefined();
    expect(config.audio["test-model"]).toBeDefined();
    expect(result).toBe(config.audio["test-model"]);
  });

  it("returns existing config without overwriting", () => {
    const config = { audio: { "test-model": { key: "value" } } };
    const result = ex.ensureModelConfig(config, "test-model");
    expect(result).toEqual({ key: "value" });
  });

  it("replaces non-object model config with defaults", () => {
    const config = { audio: { "test-model": "not-an-object" } };
    const result = ex.ensureModelConfig(config, "test-model");
    expect(typeof result).toBe("object");
  });
});

describe("getMergedModelConfig", () => {
  it("merges default config with user config", () => {
    const config = { audio: { "test-model": { key: "user-value" } } };
    const result = ex.getMergedModelConfig(config, "test-model");
    expect(result.key).toBe("user-value");
  });
});

describe("labelForModelParam", () => {
  it("replaces underscores with spaces as fallback", () => {
    expect(ex.labelForModelParam("sample_rate")).toBe("sample rate");
  });
});

describe("readModelParamInput", () => {
  it("reads boolean value", () => {
    const input = { dataset: { valueType: "boolean" }, checked: true };
    expect(ex.readModelParamInput(input)).toBe(true);
  });

  it("reads number value", () => {
    const input = { dataset: { valueType: "number" }, value: "3.14" };
    expect(ex.readModelParamInput(input)).toBe(3.14);
  });

  it("returns undefined for invalid number", () => {
    const input = { dataset: { valueType: "number" }, value: "abc" };
    expect(ex.readModelParamInput(input)).toBeUndefined();
  });

  it("reads string value trimmed", () => {
    const input = { dataset: { valueType: "string" }, value: "  hello  " };
    expect(ex.readModelParamInput(input)).toBe("hello");
  });
});

describe("soundFileName", () => {
  it('returns "内置默认" for empty path', () => {
    expect(ex.soundFileName("")).toBe("内置默认");
    expect(ex.soundFileName(null)).toBe("内置默认");
    expect(ex.soundFileName(undefined)).toBe("内置默认");
  });

  it("extracts filename from path", () => {
    expect(ex.soundFileName("/path/to/sound.mp3")).toBe("sound.mp3");
  });

  it("extracts filename from Windows path", () => {
    expect(ex.soundFileName("C:\\Users\\test\\sound.mp3")).toBe("sound.mp3");
  });

  it("returns original if no separator", () => {
    expect(ex.soundFileName("no-separator")).toBe("no-separator");
  });
});

describe("renderModelConfigRows", () => {
  it("renders boolean config as toggle HTML", () => {
    const html = ex.renderModelConfigRows("model-1", { enable: true });
    expect(html).toContain("checkbox");
    expect(html).toContain("checked");
    expect(html).toContain('data-value-type="boolean"');
  });

  it("renders number config as input HTML", () => {
    const html = ex.renderModelConfigRows("model-1", { threshold: 0.5 });
    expect(html).toContain('type="number"');
    expect(html).toContain("0.5");
    expect(html).toContain('data-value-type="number"');
  });

  it("renders string config as text input HTML", () => {
    const html = ex.renderModelConfigRows("model-1", { prompt: "hello" });
    expect(html).toContain('type="text"');
    expect(html).toContain("hello");
    expect(html).toContain('data-value-type="string"');
  });

  it("returns empty string for empty values", () => {
    expect(ex.renderModelConfigRows("model-1", {})).toBe("");
  });

  it("escapes HTML in labels", () => {
    const html = ex.renderModelConfigRows("model-1", {
      "<script>alert(1)</script>": "value",
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("resolveTheme", () => {
  it('returns "dark" when preference is "dark"', () => {
    expect(ex.resolveTheme("dark")).toBe("dark");
  });

  it('returns "light" when preference is "light"', () => {
    expect(ex.resolveTheme("light")).toBe("light");
  });

  it('returns "dark" when system prefers dark', () => {
    window.matchMedia.mockReturnValue({ matches: true });
    expect(ex.resolveTheme("system")).toBe("dark");
  });

  it('returns "light" when system prefers light', () => {
    window.matchMedia.mockReturnValue({ matches: false });
    expect(ex.resolveTheme("system")).toBe("light");
  });

  it('returns "dark" for undefined/empty preference', () => {
    expect(ex.resolveTheme(undefined)).toBe("dark");
    expect(ex.resolveTheme("")).toBe("dark");
  });
});
