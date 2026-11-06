import { describe, expect, test } from "vitest";
import {
  addedProviderIds,
  allVisibleLlmModels,
  asRecord,
  asrCredentialValues,
  catalogProviders,
  credentialsFilled,
  DEFAULT_ADDED_PROVIDERS,
  deriveAddedProviders,
  llmCredentialValues,
  presetRequestId,
  resolveDefaultLlmModel,
  visibleAsrModels,
  visibleLlmModels,
  visibleProviders,
  withAddedProvider,
  withAsrCredential,
  withAsrModelVisible,
  withDefaultLlmModel,
  withLlmCredential,
  withLlmModels,
  withoutProvider,
} from "@/settings/lib/providers";
import type { RegistryModel, RegistryProvider } from "@/settings/types/models";

const rec = (value: unknown): Record<string, Record<string, unknown>> =>
  (value && typeof value === "object" ? (value as never) : {}) as never;

const PROVIDERS: RegistryProvider[] = [
  {
    id: "bytedance",
    name: "字节跳动",
    kind: "online",
    capabilities: ["asr", "llm"],
    credentials: {
      asr: { fields: [{ key: "url" }, { key: "api_key", type: "password" }] },
      llm: { fields: [{ key: "url" }, { key: "api_key", type: "password" }] },
    },
  },
  { id: "elevenlabs", name: "ElevenLabs", kind: "online", capabilities: ["asr"] },
  { id: "local_asr", name: "本地语音识别模型", kind: "local", capabilities: ["asr"] },
  { id: "deepseek", name: "DeepSeek", kind: "online", capabilities: ["llm"] },
  { id: "ollama", name: "Ollama", kind: "local", capabilities: ["llm"] },
];

const MODELS: RegistryModel[] = [
  {
    id: "doubao-streaming",
    provider: "bytedance",
    type: "online",
    category: "asr",
    name: "豆包流式",
  },
  {
    id: "elevenlabs-realtime",
    provider: "elevenlabs",
    type: "online",
    category: "asr",
    name: "Scribe v2",
  },
  {
    id: "sherpa-sense-voice",
    provider: "local_asr",
    type: "offline",
    category: "asr",
    name: "SenseVoice",
  },
  {
    id: "doubao-seed-1-6",
    provider: "bytedance",
    type: "online",
    category: "llm",
    name: "Doubao-Seed-1.6",
    default_config: { model_id: "doubao-seed-1-6-250615" },
  },
  {
    id: "doubao-seed-1-6-flash",
    provider: "bytedance",
    type: "online",
    category: "llm",
    name: "Doubao-Seed-1.6-flash",
    default_config: { model_id: "doubao-seed-1-6-flash-250715" },
  },
  {
    id: "deepseek-flash",
    provider: "deepseek",
    type: "online",
    category: "llm",
    name: "DeepSeek Flash",
    default_config: { model_id: "deepseek-flash" },
  },
  {
    id: "ollama-qwen",
    provider: "ollama",
    type: "online",
    category: "llm",
    name: "Qwen",
    default_config: { model_id: "qwen3.5:4b" },
  },
];

const FRESH_CONFIG = {};

describe("provider visibility", () => {
  test("fresh config shows the default set only", () => {
    expect(addedProviderIds(FRESH_CONFIG)).toEqual([...DEFAULT_ADDED_PROVIDERS]);
    expect(visibleProviders(FRESH_CONFIG, PROVIDERS).map((p) => p.id)).toEqual([
      "bytedance",
      "local_asr",
    ]);
    expect(catalogProviders(FRESH_CONFIG, PROVIDERS).map((p) => p.id)).toEqual([
      "elevenlabs",
      "deepseek",
      "ollama",
    ]);
  });

  test("explicit added list is the truth", () => {
    const config = { model_providers: { added: ["bytedance", "deepseek"] } };
    expect(addedProviderIds(config)).toEqual(["bytedance", "deepseek"]);
  });

  test("legacy config derivation keeps configured providers visible", () => {
    // Old user: llm.provider = deepseek with key, ASR on elevenlabs.
    const config = {
      llm: {
        provider: "deepseek",
        deepseek: { url: "", api_key: "sk-x", model: "deepseek-flash" },
      },
      audio: { provider: "elevenlabs-realtime", "elevenlabs-realtime": { api_key: "k" } },
    };
    const derived = new Set(deriveAddedProviders(config, MODELS));
    expect(derived.has("deepseek")).toBe(true);
    expect(derived.has("elevenlabs")).toBe(true);
    expect(derived.has("local_asr")).toBe(true);
  });

  test("canonical asr credentials imply the provider is in use", () => {
    const config = { audio: { credentials: { elevenlabs: { api_key: "k" } } } };
    expect(deriveAddedProviders(config)).toContain("elevenlabs");
  });
});

describe("llm model lists", () => {
  test("absent list shows all presets", () => {
    const views = visibleLlmModels({}, "bytedance", MODELS);
    expect(views.map((v) => v.id)).toEqual(["doubao-seed-1-6", "doubao-seed-1-6-flash"]);
    expect(presetRequestId(views[0].preset as RegistryModel)).toBe("doubao-seed-1-6-250615");
  });

  test("present list is the truth, custom entries included", () => {
    const llm = {
      bytedance: {
        models: [
          { id: "doubao-seed-1-6", params: { temperature: 0.4 } },
          { id: "my-model", name: "我的模型" },
        ],
      },
    };
    const views = visibleLlmModels(llm, "bytedance", MODELS);
    expect(views).toHaveLength(2);
    expect(views[0].params?.temperature).toBe(0.4);
    expect(views[1].preset).toBeUndefined();
    expect(views[1].name).toBe("我的模型");
  });

  test("empty list hides presets", () => {
    const views = visibleLlmModels({ bytedance: { models: [] } }, "bytedance", MODELS);
    expect(views).toEqual([]);
  });

  test("legacy model string matching no preset surfaces as custom entry", () => {
    const llm = { bytedance: { model: "doubao-pro-custom" } };
    const views = visibleLlmModels(llm, "bytedance", MODELS);
    const custom = views.find((v) => v.id === "doubao-pro-custom");
    expect(custom).toBeDefined();
    expect(custom?.preset).toBeUndefined();
  });

  test("legacy model string matching a preset request id adds no duplicate", () => {
    const llm = { bytedance: { model: "doubao-seed-1-6-250615" } };
    const views = visibleLlmModels(llm, "bytedance", MODELS);
    expect(views.filter((v) => v.id.includes("doubao-seed-1-6"))).toHaveLength(2);
  });

  test("default resolution mirrors backend priority", () => {
    // default_model wins
    const withDefault = {
      default_model: "doubao-seed-1-6-flash",
      bytedance: { models: [{ id: "doubao-seed-1-6" }, { id: "doubao-seed-1-6-flash" }] },
    };
    expect(resolveDefaultLlmModel(withDefault, "bytedance", MODELS)?.id).toBe(
      "doubao-seed-1-6-flash",
    );
    // legacy string beats first preset
    const legacy = { bytedance: { model: "doubao-pro-custom" } };
    expect(resolveDefaultLlmModel(legacy, "bytedance", MODELS)?.id).toBe("doubao-pro-custom");
    // plain fallback to first preset
    expect(resolveDefaultLlmModel({}, "bytedance", MODELS)?.id).toBe("doubao-seed-1-6");
  });
});

describe("asr model visibility", () => {
  test("absent list shows all provider presets", () => {
    expect(visibleAsrModels({}, "bytedance", MODELS).map((m) => m.id)).toEqual([
      "doubao-streaming",
    ]);
  });

  test("present list filters", () => {
    const audio = { models: ["elevenlabs-realtime"] };
    expect(visibleAsrModels(audio, "bytedance", MODELS)).toEqual([]);
    expect(visibleAsrModels(audio, "elevenlabs", MODELS).map((m) => m.id)).toEqual([
      "elevenlabs-realtime",
    ]);
  });
});

describe("credentials", () => {
  test("asr values layer canonical over legacy", () => {
    const config = {
      audio: {
        provider: "doubao-streaming",
        "doubao-streaming": { api_key: "legacy", language: "ja" },
        credentials: { bytedance: { api_key: "canon" } },
      },
    };
    const values = asrCredentialValues(config, "bytedance", MODELS);
    expect(values.api_key).toBe("canon");
    expect(values.language).toBe("ja");
  });

  test("llm values fall back to top-level legacy fields", () => {
    const config = { llm: { deepseek: {}, url: "https://top", api_key: "top-key" } };
    expect(llmCredentialValues(config, "deepseek")).toEqual({
      url: "https://top",
      api_key: "top-key",
    });
  });

  test("credentialsFilled requires every declared field", () => {
    const fields = [{ key: "url" }, { key: "api_key" }];
    expect(credentialsFilled({ url: "u" }, fields)).toBe(false);
    expect(credentialsFilled({ url: "u", api_key: "k" }, fields)).toBe(true);
    expect(credentialsFilled({}, undefined)).toBe(true);
  });
});

describe("config patches", () => {
  test("adding preserves an active legacy ASR provider", () => {
    const next = withAddedProvider(
      { audio: { provider: "elevenlabs-realtime" } },
      "deepseek",
      MODELS,
    );
    expect(asRecord(next.model_providers).added).toContain("elevenlabs");
  });

  test("editing models migrates legacy defaults including preset request ids", () => {
    for (const legacy of ["doubao-seed-1-6-flash-250715", "custom-model"]) {
      const config = { llm: { provider: "bytedance", model: legacy, bytedance: {} } };
      const entries = visibleLlmModels(config.llm, "bytedance", MODELS).map((v) => ({ id: v.id }));
      const next = withLlmModels(config, "bytedance", entries, MODELS);
      expect(asRecord(next.llm).default_model).toBe(
        legacy === "custom-model" ? legacy : "doubao-seed-1-6-flash",
      );
      expect(asRecord(next.llm).model).toBeUndefined();
    }
  });

  test("editing another provider preserves the implicit bytedance default", () => {
    const config = {
      llm: {
        default_model: "doubao-seed-1-6-flash",
        model: "old-top",
        deepseek: { model: "deepseek-flash" },
      },
    };
    const next = withLlmModels(config, "deepseek", [{ id: "deepseek-flash" }], MODELS);
    expect(asRecord(next.llm).default_model).toBe("doubao-seed-1-6-flash");
    expect(asRecord(next.llm).model).toBe("old-top");
  });

  test("custom provider reads canonical section first and migrates legacy on writes", () => {
    const legacy = {
      llm: {
        provider: "openai_compatible",
        openai_compatible: { url: "old", api_key: "secret", model: "custom-model" },
      },
    };
    expect(addedProviderIds(legacy, MODELS)).toContain("custom_openai");
    expect(resolveDefaultLlmModel(legacy.llm, "custom_openai", MODELS)?.id).toBe("custom-model");
    const migrated = withLlmCredential(legacy, "custom_openai", "url", "new");
    expect(asRecord(migrated.llm).provider).toBe("custom_openai");
    expect(asRecord(migrated.llm).openai_compatible).toBeUndefined();
    expect(llmCredentialValues(migrated, "custom_openai")).toEqual({
      url: "new",
      api_key: "secret",
    });
    const both = {
      llm: {
        openai_compatible: { url: "old", api_key: "old" },
        custom_openai: { url: "", api_key: "" },
      },
    };
    expect(llmCredentialValues(both, "custom_openai")).toEqual({ url: "", api_key: "" });
    expect(visibleLlmModels(both.llm, "custom_openai", MODELS)).toEqual([]);
    const top = {
      llm: {
        provider: "openai_compatible",
        url: "top-url",
        api_key: "top-key",
        openai_compatible: {},
      },
    };
    const cleared = withLlmCredential(top, "custom_openai", "url", "");
    expect(llmCredentialValues(cleared, "custom_openai")).toEqual({ url: "", api_key: "top-key" });
    expect(asRecord(cleared.llm)).not.toHaveProperty("url");
    expect(asRecord(cleared.llm)).not.toHaveProperty("api_key");
    const partial = {
      llm: {
        provider: "openai_compatible",
        url: "top-url",
        api_key: "top-key",
        custom_openai: null,
        openai_compatible: { url: "legacy-url", api_key: "", model: "legacy-model" },
      },
    };
    expect(llmCredentialValues(partial, "custom_openai")).toEqual({
      url: "legacy-url",
      api_key: "top-key",
    });
    const migratedPartial = withLlmCredential(partial, "custom_openai", "url", "edited");
    expect(asRecord(asRecord(migratedPartial.llm).custom_openai)).toEqual({
      url: "edited",
      api_key: "top-key",
      model: "legacy-model",
    });
    const canonical = {
      llm: {
        provider: "custom_openai",
        url: "top-url",
        api_key: "top-key",
        openai_compatible: { url: "legacy-url", api_key: "legacy-key" },
        custom_openai: { url: "", api_key: "" },
      },
    };
    expect(llmCredentialValues(canonical, "custom_openai")).toEqual({ url: "", api_key: "" });
    const editedCanonical = withLlmCredential(canonical, "custom_openai", "url", "edited");
    expect(llmCredentialValues(editedCanonical, "custom_openai")).toEqual({
      url: "edited",
      api_key: "",
    });
  });

  test("removing a provider clears only its declared legacy secrets and active top-level fields", () => {
    const config = {
      llm: {
        provider: "openai_compatible",
        url: "top",
        api_key: "top-secret",
        model: "top-model",
        openai_compatible: { api_key: "old" },
        custom_openai: { api_key: "new" },
        deepseek: { api_key: "keep" },
      },
      audio: {
        "doubao-streaming": { api_key: "remove", url: "remove", language: "keep" },
        "elevenlabs-realtime": { api_key: "keep" },
      },
      model_providers: {
        added: ["custom_openai", "bytedance", "deepseek"],
        credentials: { custom_openai: { api_key: "new" }, openai_compatible: { api_key: "old" } },
      },
    };
    const custom = withoutProvider(config, "custom_openai", PROVIDERS, MODELS);
    expect(asRecord(custom.llm)).not.toHaveProperty("api_key");
    expect(asRecord(custom.llm)).not.toHaveProperty("model");
    expect(asRecord(custom.llm)).not.toHaveProperty("openai_compatible");
    expect(asRecord(custom.llm)).not.toHaveProperty("custom_openai");
    expect(asRecord(asRecord(custom.llm).deepseek).api_key).toBe("keep");
    expect(asRecord(asRecord(custom.model_providers).credentials)).toEqual({});
    const asr = withoutProvider(config, "bytedance", PROVIDERS, MODELS);
    expect(asRecord(asRecord(asr.audio)["doubao-streaming"])).toEqual({ language: "keep" });
    expect(asRecord(asRecord(asr.audio)["elevenlabs-realtime"]).api_key).toBe("keep");
    expect(asRecord(asr.llm).api_key).toBe("top-secret");
  });

  test("ASR fallback respects visibility and downloaded status", () => {
    const config = {
      audio: { provider: "doubao-streaming" },
      model_providers: { added: ["bytedance", "local_asr"] },
    };
    expect(
      asRecord(withAsrModelVisible(config, "doubao-streaming", false, MODELS).audio).provider,
    ).toBe("");
    expect(
      asRecord(
        withAsrModelVisible(
          config,
          "doubao-streaming",
          false,
          MODELS,
          (m) => m.id === "sherpa-sense-voice",
        ).audio,
      ).provider,
    ).toBe("sherpa-sense-voice");
    expect(asRecord(withoutProvider(config, "bytedance", PROVIDERS, MODELS).audio).provider).toBe(
      "",
    );
  });

  test("missing ASR provider uses the implicit doubao default when removing it", () => {
    const config = { audio: {}, model_providers: { added: ["bytedance", "elevenlabs"] } };
    expect(asRecord(withoutProvider(config, "bytedance", PROVIDERS, MODELS).audio).provider).toBe(
      "elevenlabs-realtime",
    );
    expect(
      asRecord(withAsrModelVisible(config, "doubao-streaming", false, MODELS).audio).provider,
    ).toBe("elevenlabs-realtime");
    const explicitEmpty = { ...config, audio: { provider: "" } };
    expect(
      asRecord(withAsrModelVisible(explicitEmpty, "doubao-streaming", false, MODELS).audio)
        .provider,
    ).toBe("");
  });

  test("removing the implicit LLM provider clears its credentials and selects a remaining provider", () => {
    const next = withoutProvider(
      {
        llm: { default_model: "doubao-seed-1-6-flash", api_key: "bytedance-key" },
        model_providers: { added: ["bytedance", "deepseek"] },
      },
      "bytedance",
      PROVIDERS,
      MODELS,
    );
    expect(asRecord(next.llm)).toEqual({ provider: "deepseek", default_model: "" });
  });

  test("withAddedProvider appends and keeps the original untouched", () => {
    const config = { model_providers: { added: ["bytedance"] } };
    const next = withAddedProvider(config, "deepseek");
    expect(rec(next.model_providers).added).toEqual(["bytedance", "deepseek"]);
    expect(config.model_providers.added).toEqual(["bytedance"]);
  });

  test("adding a provider leaves its models empty and keeps existing models", () => {
    const config = {
      model_providers: { added: ["bytedance"] },
      audio: {},
      llm: { provider: "bytedance" },
    };
    const next = withAddedProvider(config, "elevenlabs", MODELS);
    expect(visibleAsrModels(rec(next.audio), "elevenlabs", MODELS)).toEqual([]);
    expect(visibleAsrModels(rec(next.audio), "bytedance", MODELS).length).toBeGreaterThan(0);
    const llmNext = withAddedProvider(config, "deepseek", MODELS);
    expect(visibleLlmModels(rec(llmNext.llm), "deepseek", MODELS)).toEqual([]);
    expect(visibleLlmModels(rec(llmNext.llm), "bytedance", MODELS).length).toBeGreaterThan(0);
  });

  test("withLlmModels clears the legacy model field", () => {
    const config = { llm: { bytedance: { url: "u", model: "old" } } };
    const next = withLlmModels(config, "bytedance", [{ id: "my-model" }]);
    expect(rec(next.llm).bytedance.model).toBe("");
    expect(rec(next.llm).bytedance.models).toEqual([{ id: "my-model" }]);
    expect(rec(next.llm).bytedance.url).toBe("u");
  });

  test("withDefaultLlmModel writes provider and model together", () => {
    const next = withDefaultLlmModel(
      { llm: { provider: "bytedance" } },
      "deepseek",
      "deepseek-flash",
    );
    expect(rec(next.llm).provider).toBe("deepseek");
    expect(rec(next.llm).default_model).toBe("deepseek-flash");
  });

  test("withAsrModelVisible reselects the default when it is removed", () => {
    const config = { audio: { provider: "doubao-streaming" } };
    const next = withAsrModelVisible(config, "doubao-streaming", false, MODELS);
    expect(rec(next.audio).models).not.toContain("doubao-streaming");
    expect(rec(next.audio).provider).toBe("");
  });

  test("withAsrCredential writes canonical and strips the legacy copy", () => {
    const config = {
      audio: { "doubao-streaming": { api_key: "legacy", language: "ja" } },
    };
    const next = withAsrCredential(config, "bytedance", "api_key", "new", MODELS);
    expect(asRecord(asRecord(asRecord(next.audio).credentials).bytedance).api_key).toBe("new");
    expect(asRecord(asRecord(next.audio)["doubao-streaming"]).api_key).toBeUndefined();
    expect(asRecord(asRecord(next.audio)["doubao-streaming"]).language).toBe("ja");
  });

  test("withoutProvider clears sections and falls back defaults", () => {
    const config = {
      llm: {
        provider: "deepseek",
        default_model: "deepseek-flash",
        deepseek: { url: "u", api_key: "k", models: [{ id: "deepseek-flash" }] },
      },
      audio: {
        provider: "doubao-streaming",
        credentials: { bytedance: { api_key: "k" } },
      },
      model_providers: { added: ["bytedance", "local_asr", "deepseek"] },
    };
    const next = withoutProvider(config, "bytedance", PROVIDERS, MODELS);
    // Provider gone from list
    expect(rec(next.model_providers).added).not.toContain("bytedance");
    // ASR credentials cleared
    expect(asRecord(asRecord(next.audio).credentials).bytedance).toBeUndefined();
    // Active ASR model belonged to the removed provider → falls back to the
    // offline models are unavailable unless explicitly confirmed downloaded.
    expect(rec(next.audio).provider).toBe("");

    const nextLlm = withoutProvider(config, "deepseek", PROVIDERS, MODELS);
    expect(rec(nextLlm.llm).deepseek).toBeUndefined();
    // LLM default falls back to bytedance (still visible)
    expect(rec(nextLlm.llm).provider).toBe("bytedance");
    expect(allVisibleLlmModels(nextLlm, PROVIDERS, MODELS).length).toBeGreaterThan(0);
  });

  test("removing an asr provider respects downloaded local models", () => {
    const config = {
      audio: { provider: "elevenlabs-realtime" },
      model_providers: { added: ["bytedance", "local_asr", "elevenlabs"] },
    };
    // local model not downloaded → fallback picks doubao, not sherpa
    const next = withoutProvider(
      config,
      "elevenlabs",
      PROVIDERS,
      MODELS,
      (m) => m.type === "online",
    );
    expect(rec(next.audio).provider).toBe("doubao-streaming");
  });
});
