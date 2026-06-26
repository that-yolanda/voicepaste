import { describe, expect, it } from "vitest";
import { clonePlain } from "@/settings/lib/clone";
import {
  type AsrDefaults,
  getFieldMeta,
  getMergedAsrConfig,
  inferControlType,
} from "@/settings/lib/model";
import { soundFileName } from "@/settings/lib/sound";
import type { RegistryModel } from "@/settings/types/models";

describe("getMergedAsrConfig", () => {
  const model: RegistryModel = {
    id: "test-model",
    type: "offline",
    category: "asr",
    name: "Test",
    default_config: {
      use_itn: true,
      language: "auto",
      corpus: { boosting_table_id: "" },
    },
  };

  it("merges default_config with user overrides (user wins)", () => {
    const fields = getMergedAsrConfig(model, { language: "zh" });
    const map = Object.fromEntries(fields.map((f) => [f.key, f.value]));
    expect(map.use_itn).toBe(true);
    expect(map.language).toBe("zh");
  });

  it("flattens nested objects one level", () => {
    const fields = getMergedAsrConfig(model, {});
    expect(fields.some((f) => f.key === "corpus.boosting_table_id")).toBe(true);
  });

  it("returns [] for a model without default_config", () => {
    const fields = getMergedAsrConfig({ id: "x", type: "offline", name: "X" }, undefined);
    expect(fields).toEqual([]);
  });
});

describe("getFieldMeta", () => {
  it("returns FIELD_META entry for a known key", () => {
    const meta = getFieldMeta("url", "");
    expect(meta.label).toBe("WebSocket 地址");
    expect(meta.type).toBe("text");
  });

  it("assigns a segment type + options for enum keys", () => {
    const meta = getFieldMeta("provider", "cpu");
    expect(meta.type).toBe("segment");
    expect(meta.options?.length).toBeGreaterThan(0);
  });

  it("falls back to an underscore-replaced label for unknown keys", () => {
    const meta = getFieldMeta("some_unknown_key", 1);
    expect(meta.label).toBe("some unknown key");
  });
});

describe("inferControlType", () => {
  it("infers toggle from boolean", () => {
    expect(inferControlType("x", true)).toBe("toggle");
  });
  it("infers number from number", () => {
    expect(inferControlType("x", 5)).toBe("number");
  });
  it("infers textarea from prompt key", () => {
    expect(inferControlType("system_prompt", "")).toBe("textarea");
  });
  it("infers password from token/secret keys", () => {
    expect(inferControlType("access_token", "")).toBe("password");
    expect(inferControlType("secret_key", "")).toBe("password");
  });
  it("defaults to text", () => {
    expect(inferControlType("url", "")).toBe("text");
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

// type-only compile check: AsrDefaults shape is stable.
describe("AsrDefaults", () => {
  it("satisfies the expected structure", () => {
    const defaults: AsrDefaults = {
      rate: 16000,
      channel: 1,
      stream_simulate: true,
      hotword_llm_mode: "auto",
      hotword_replace: true,
      num_threads: 2,
      provider: "cpu",
      punctuation_mode: "auto",
      vad: {
        threshold: 0.2,
        min_silence_duration: 0.2,
        min_speech_duration: 0.2,
        max_speech_duration: 10,
      },
    };
    expect(defaults.vad.threshold).toBe(0.2);
  });
});
