import { describe, expect, it } from "vitest";
import { clonePlain } from "@/lib/clone";
import {
  ensureModelConfig,
  getAsrProvider,
  getMergedModelConfig,
  labelForModelParam,
  type RegistryModel,
  readModelParamInput,
  renderModelConfigRows,
} from "@/lib/model";
import { soundFileName } from "@/lib/sound";

describe("getAsrProvider", () => {
  it("returns doubao-streaming by default", () => {
    expect(getAsrProvider({})).toBe("doubao-streaming");
  });
  it("returns configured provider", () => {
    expect(getAsrProvider({ audio: { provider: "sherpa-onnx" } })).toBe("sherpa-onnx");
  });
});

describe("ensureModelConfig", () => {
  it("creates audio section if missing", () => {
    const config: Record<string, unknown> = {};
    const result = ensureModelConfig(config, "test-model", null);
    expect(config.audio).toBeDefined();
    expect(result).toBeDefined();
  });
  it("returns existing config without overwriting", () => {
    const config = { audio: { "test-model": { key: "value" } } };
    const result = ensureModelConfig(config, "test-model", null);
    expect(result).toEqual({ key: "value" });
  });
  it("replaces non-object model config with defaults", () => {
    const config = { audio: { "test-model": "not-an-object" } };
    const result = ensureModelConfig(config, "test-model", null);
    expect(typeof result).toBe("object");
  });
});

describe("getMergedModelConfig", () => {
  it("merges default config with user config", () => {
    const registry: RegistryModel[] = [
      {
        id: "test-model",
        default_config: { key: "default" },
        type: "offline",
        name: "Test",
        category: "asr",
      },
    ];
    const config = { audio: { "test-model": { key: "user-value" } } };
    const result = getMergedModelConfig(config, "test-model", registry);
    expect(result.key).toBe("user-value");
  });
});

describe("labelForModelParam", () => {
  it("replaces underscores with spaces as fallback", () => {
    expect(labelForModelParam("sample_rate")).toBe("sample rate");
  });
});

describe("readModelParamInput", () => {
  it("reads boolean value", () => {
    const input = {
      dataset: { valueType: "boolean" },
      checked: true,
    } as unknown as HTMLInputElement;
    expect(readModelParamInput(input)).toBe(true);
  });
  it("reads number value", () => {
    const input = {
      dataset: { valueType: "number" },
      value: "3.14",
    } as unknown as HTMLInputElement;
    expect(readModelParamInput(input)).toBe(3.14);
  });
  it("returns undefined for invalid number", () => {
    const input = {
      dataset: { valueType: "number" },
      value: "abc",
    } as unknown as HTMLInputElement;
    expect(readModelParamInput(input)).toBeUndefined();
  });
  it("reads string value trimmed", () => {
    const input = {
      dataset: { valueType: "string" },
      value: "  hello  ",
    } as unknown as HTMLInputElement;
    expect(readModelParamInput(input)).toBe("hello");
  });
});

describe("soundFileName", () => {
  it('returns "内置默认" for empty path', () => {
    expect(soundFileName("")).toBe("内置默认");
    expect(soundFileName(null as unknown as string)).toBe("内置默认");
    expect(soundFileName(undefined as unknown as string)).toBe("内置默认");
  });
  it("extracts filename from path", () => {
    expect(soundFileName("/path/to/sound.mp3")).toBe("sound.mp3");
  });
  it("extracts filename from Windows path", () => {
    expect(soundFileName("C:\\Users\\test\\sound.mp3")).toBe("sound.mp3");
  });
  it("returns original if no separator", () => {
    expect(soundFileName("no-separator")).toBe("no-separator");
  });
});

describe("renderModelConfigRows", () => {
  it("renders boolean config as toggle HTML", () => {
    const html = renderModelConfigRows("model-1", { enable: true });
    expect(html).toContain("checkbox");
    expect(html).toContain("checked");
    expect(html).toContain('data-value-type="boolean"');
  });
  it("renders number config as input HTML", () => {
    const html = renderModelConfigRows("model-1", { threshold: 0.5 });
    expect(html).toContain('type="number"');
    expect(html).toContain("0.5");
    expect(html).toContain('data-value-type="number"');
  });
  it("renders string config as text input HTML", () => {
    const html = renderModelConfigRows("model-1", { prompt: "hello" });
    expect(html).toContain('type="text"');
    expect(html).toContain("hello");
    expect(html).toContain('data-value-type="string"');
  });
  it("returns empty string for empty values", () => {
    expect(renderModelConfigRows("model-1", {})).toBe("");
  });
  it("escapes HTML in labels", () => {
    const html = renderModelConfigRows("model-1", { "<script>alert(1)</script>": "value" });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("clonePlain", () => {
  it("deep clones a plain object", () => {
    const obj = { a: 1, b: { c: 2 } };
    const cloned = clonePlain(obj);
    expect(cloned).toEqual(obj);
    expect(cloned).not.toBe(obj);
    expect(cloned.b).not.toBe(obj.b);
  });
  it("returns empty object for null/undefined", () => {
    expect(clonePlain(null as unknown as Record<string, unknown>)).toEqual({});
    expect(clonePlain(undefined as unknown as Record<string, unknown>)).toEqual({});
  });
  it("handles arrays", () => {
    expect(clonePlain([1, 2, 3])).toEqual([1, 2, 3]);
  });
});
