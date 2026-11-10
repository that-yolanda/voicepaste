import { describe, expect, it } from "vitest";
import { clonePlain } from "@/settings/lib/clone";
import {
  type AsrDefaults,
  getFieldMeta,
  getMergedAsrConfig,
  inferControlType,
  isModelFieldVisible,
  localizedModelFields,
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
    expect(meta.label).toBe("field.url");
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

describe("localizedModelFields", () => {
  const model = {
    id: "test",
    type: "online",
    name: "测试模型",
    name_en: "Test model",
    description: "中文描述",
    description_en: "English description",
    languages: ["zh", "en"],
  } satisfies Parameters<typeof localizedModelFields>[0];

  it("uses English fields when the UI language is English", () => {
    const fields = localizedModelFields(model, "en");
    expect(fields.name).toBe("Test model");
    expect(fields.description).toBe("English description");
    expect(fields.languages).toEqual(["zh", "en"]);
  });

  it("falls back to the Chinese base fields for Chinese and when *_en is absent", () => {
    expect(localizedModelFields(model, "zh-CN").name).toBe("测试模型");
    const bare = localizedModelFields({ id: "x", type: "online", name: "只有中文" }, "en");
    expect(bare.name).toBe("只有中文");
    expect(bare.languages).toEqual([]);
  });
});

describe("Doubao mode-specific controls", () => {
  const sentence = { url: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream" };
  const live = {
    url: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async",
    end_window_size: 800,
  };
  it("uses named choices only for Doubao", () => {
    expect(getFieldMeta("url", "", "doubao-streaming").type).toBe("select");
    expect(getFieldMeta("resource_id", "", "doubao-streaming").options).toHaveLength(2);
    expect(getFieldMeta("url", "", "another-provider").type).toBe("text");
  });
  it("shows language only for sentence recognition and refinement only for live recognition", () => {
    expect(isModelFieldVisible("doubao-streaming", "language", sentence)).toBe(true);
    expect(isModelFieldVisible("doubao-streaming", "language", live)).toBe(false);
    expect(isModelFieldVisible("doubao-streaming", "enable_nonstream", sentence)).toBe(false);
    expect(isModelFieldVisible("doubao-streaming", "enable_nonstream", live)).toBe(true);
    expect(isModelFieldVisible("doubao-streaming", "vad_segment_duration", live)).toBe(false);
    expect(isModelFieldVisible("doubao-streaming", "result_type", live)).toBe(false);
    expect(isModelFieldVisible("doubao-streaming", "ssd_version", live)).toBe(false);
  });
});

describe("Qwen model settings", () => {
  it("keeps editable recommendations and hides unsupported fields", () => {
    const model: RegistryModel = {
      id: "qwen-asr-message",
      provider: "qwen",
      type: "online",
      category: "asr",
      name: "Qwen Message",
      default_config: {
        intermediate_result_enabled: true,
        enable_ddc: true,
        speech_noise_threshold: null,
      },
    };
    const values = Object.fromEntries(
      getMergedAsrConfig(model, {
        intermediate_result_enabled: false,
        speech_noise_threshold: 0.2,
      }).map((f) => [f.key, f.value]),
    );
    expect(values.intermediate_result_enabled).toBe(false);
    expect(values.enable_ddc).toBe(true);
    expect(values.speech_noise_threshold).toBe(0.2);
    expect(isModelFieldVisible(model.id, "intermediate_result_enabled", values)).toBe(true);
    expect(isModelFieldVisible(model.id, "language_hints", values)).toBe(false);
    expect(isModelFieldVisible("qwen-asr-streaming", "enable_ddc", {})).toBe(false);
    expect(isModelFieldVisible("qwen-asr-streaming", "language_hints", {})).toBe(true);
    expect(isModelFieldVisible(model.id, "format", values)).toBe(false);
    expect(getFieldMeta("speech_noise_threshold", null, model.id)).toMatchObject({
      type: "number",
      nullable: true,
      min: -1,
      max: 1,
    });
    expect(getFieldMeta("url", "", model.id).label).toBe("field.url");
    expect(getFieldMeta("url", "", model.id).tooltip).toBe("field.qwen_url.tooltip");
  });
  it("preserves legacy smoothing values while sharing the existing field metadata", () => {
    const model: RegistryModel = {
      id: "qwen-asr-message",
      provider: "qwen",
      type: "online",
      category: "asr",
      name: "Qwen Message",
      default_config: { enable_ddc: true },
    };
    const fields = Object.fromEntries(
      getMergedAsrConfig(model, { disfluency_removal_enabled: false }).map((f) => [f.key, f.value]),
    );
    expect(fields.enable_ddc).toBe(false);
    expect(fields).not.toHaveProperty("disfluency_removal_enabled");
    expect(getFieldMeta("enable_ddc", true, model.id).label).toBe(
      getFieldMeta("enable_ddc", true, "elevenlabs-realtime").label,
    );
    expect(getFieldMeta("enable_ddc", true, model.id).tooltip).toBe("field.enable_ddc.tooltip");
  });
});
