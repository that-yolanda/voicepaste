/**
 * Provider-layer normalization over the raw config.yaml object.
 *
 * Pure functions only — the settings pages call them to derive what the UI
 * shows (provider visibility, positive model lists, credential values) and to
 * build immutable config patches. They mirror the backend resolution rules in
 * llm.rs / config.rs `resolve_model_config`; changing one side means changing
 * the other.
 */

import type {
  LlmModelEntry,
  LlmModelParams,
  RegistryModel,
  RegistryProvider,
} from "@/settings/types/models";

/** Default provider set for fresh installs (mirrors config.rs). */
export const DEFAULT_ADDED_PROVIDERS = ["bytedance", "local_asr"] as const;

export const DOUBAO_FALLBACK_MODEL_ID = "doubao-streaming";

type Rec = Record<string, unknown>;

function canonicalProviderId(id: string): string {
  return id === "openai_compatible" ? "custom_openai" : id;
}

function llmProviderConfig(llm: Rec, providerId: string): Rec {
  return providerId === "custom_openai"
    ? asRecord(llm.custom_openai == null ? llm.openai_compatible : llm.custom_openai)
    : asRecord(llm[providerId]);
}

function migrateCustomProvider(llm: Rec, providerId: string): void {
  if (providerId !== "custom_openai") return;
  const hasCanonical = llm.custom_openai != null;
  const pc = { ...llmProviderConfig(llm, providerId) };
  if (typeof llm.provider === "string" && canonicalProviderId(llm.provider) === providerId) {
    for (const key of ["url", "api_key"]) {
      if (!hasCanonical && !pc[key] && llm[key]) pc[key] = llm[key];
      delete llm[key];
    }
  }
  llm.custom_openai = pc;
  delete llm.openai_compatible;
  if (llm.provider === "openai_compatible") llm.provider = "custom_openai";
}

export function asRecord(value: unknown): Rec {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : {};
}

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : null;
}

/* ======================================================================
   Provider visibility (model_providers.added, positive list)
   ====================================================================== */

/**
 * Provider ids visible in the model services list. `model_providers.added`
 * is the truth when present; otherwise it is derived for legacy configs:
 * the default set plus every provider with live configuration (active LLM
 * provider, providers with credentials, the active ASR model's provider).
 */
export function addedProviderIds(config: Rec, models: RegistryModel[] = []): string[] {
  const added = stringList(asRecord(config.model_providers).added);
  if (added) return [...new Set(added.map(canonicalProviderId))];
  return deriveAddedProviders(config, models);
}

export function deriveAddedProviders(config: Rec, models: RegistryModel[] = []): string[] {
  const llm = asRecord(config.llm);
  const audio = asRecord(config.audio);
  const ids = new Set<string>(DEFAULT_ADDED_PROVIDERS);

  const activeLlm = typeof llm.provider === "string" ? llm.provider : "";
  if (activeLlm) ids.add(canonicalProviderId(activeLlm));
  for (const [key, value] of Object.entries(llm)) {
    const pc = asRecord(value);
    if (typeof pc.url === "string" && pc.url) ids.add(canonicalProviderId(key));
    if (typeof pc.api_key === "string" && pc.api_key) ids.add(canonicalProviderId(key));
  }
  // Capability credentials imply the provider is in use.
  for (const key of Object.keys(asRecord(audio.credentials))) ids.add(key);
  // The active ASR model's provider (legacy: model id under audio.provider).
  const activeAsr = typeof audio.provider === "string" ? audio.provider : "";
  if (activeAsr) {
    const owner = models.find((m) => m.id === activeAsr)?.provider;
    if (owner) ids.add(owner);
  }
  return [...ids];
}

/** The provider owning a model (registry models carry `provider` in v21). */
export function providerOfModel(models: RegistryModel[], modelId: string): string | undefined {
  return models.find((m) => m.id === modelId)?.provider;
}

/** Filtered view of the registry ordered as the provider list renders. */
export function visibleProviders(
  config: Rec,
  providers: RegistryProvider[],
  models: RegistryModel[] = [],
): RegistryProvider[] {
  const added = new Set(addedProviderIds(config, models));
  return providers.filter((p) => added.has(p.id));
}

/** Registry providers not yet added (AddProvider catalog entries). */
export function catalogProviders(
  config: Rec,
  providers: RegistryProvider[],
  models: RegistryModel[] = [],
): RegistryProvider[] {
  const added = new Set(addedProviderIds(config, models));
  return providers.filter((p) => !added.has(p.id));
}

/* ======================================================================
   Model visibility (positive lists)
   ====================================================================== */

/**
 * ASR models shown for a provider. `audio.models` is the truth when present;
 * otherwise all preset ASR models of the provider are visible. Base models
 * (vad / punctuation) are always visible — their state is download-based.
 */
export function visibleAsrModels(
  audio: Rec,
  providerId: string,
  models: RegistryModel[],
): RegistryModel[] {
  const list = stringList(audio.models);
  const preset = models.filter((m) => m.provider === providerId && m.category === "asr");
  if (!list) return preset;
  const visible = new Set(list);
  return preset.filter((m) => visible.has(m.id));
}

/** All ASR models across visible providers (for the default-model picker). */
export function allVisibleAsrModels(
  config: Rec,
  providers: RegistryProvider[],
  models: RegistryModel[],
): { provider: RegistryProvider; model: RegistryModel }[] {
  return visibleProviders(config, providers, models).flatMap((provider) =>
    visibleAsrModels(asRecord(config.audio), provider.id, models).map((model) => ({
      provider,
      model,
    })),
  );
}

/** LLM model view: registry preset or user-defined custom entry. */
export interface LlmModelView {
  /** Registry preset id, or the custom model's id (= request string). */
  id: string;
  name?: string;
  modelIdOverride?: string;
  params?: LlmModelParams;
  /** Registry entry when this is a preset. */
  preset?: RegistryModel;
}

function normalizeParams(value: unknown): LlmModelParams | undefined {
  const raw = asRecord(value);
  const params: LlmModelParams = {};
  if (typeof raw.temperature === "number") params.temperature = raw.temperature;
  if (typeof raw.max_tokens === "number") params.max_tokens = raw.max_tokens;
  if (typeof raw.top_p === "number") params.top_p = raw.top_p;
  return Object.keys(params).length > 0 ? params : undefined;
}

/**
 * LLM models visible for a provider. `llm.<provider>.models` is the truth
 * when the field exists (even empty — removals included); otherwise the
 * registry presets are visible, plus a synthesized custom entry when a
 * legacy single-model string does not match any preset.
 */
export function visibleLlmModels(
  llm: Rec,
  providerId: string,
  models: RegistryModel[],
): LlmModelView[] {
  const presets = models.filter((m) => m.provider === providerId && m.category === "llm");
  const providerCfg = llmProviderConfig(llm, providerId);
  const list = Array.isArray(providerCfg.models) ? providerCfg.models : null;

  if (!list) {
    const views: LlmModelView[] = presets.map((preset) => ({
      id: preset.id,
      preset,
    }));
    // Legacy normalization: a hand-typed model string that matches no preset
    // surfaces as a custom entry so old configs keep working untouched.
    const legacy = [
      typeof providerCfg.model === "string" ? providerCfg.model.trim() : "",
      typeof llm.model === "string" ? llm.model.trim() : "",
    ].find((m) => m.length > 0);
    if (legacy && !presets.some((p) => p.id === legacy || presetRequestId(p) === legacy)) {
      views.push({ id: legacy });
    }
    return views;
  }

  const views: LlmModelView[] = [];
  for (const entry of list) {
    const rec = asRecord(entry);
    const id = typeof rec.id === "string" ? rec.id : "";
    if (!id) continue;
    views.push({
      id,
      name: typeof rec.name === "string" ? rec.name : undefined,
      modelIdOverride: typeof rec.model_id === "string" ? rec.model_id : undefined,
      params: normalizeParams(rec.params),
      preset: presets.find((p) => p.id === id),
    });
  }
  return views;
}

/** Request model string for a registry preset (default_config.model_id). */
export function presetRequestId(preset: RegistryModel): string {
  const id = preset.default_config?.model_id;
  return typeof id === "string" && id ? id : preset.id;
}

/** Request model string a view would send. */
export function viewRequestId(view: LlmModelView): string {
  return view.modelIdOverride ?? (view.preset ? presetRequestId(view.preset) : view.id);
}

/**
 * The provider's active LLM model. Mirrors llm.rs priority:
 * `llm.default_model` → legacy model string → first visible → none.
 */
export function resolveDefaultLlmModel(
  llm: Rec,
  providerId: string,
  models: RegistryModel[],
): LlmModelView | null {
  const visible = visibleLlmModels(llm, providerId, models);
  const defaultId = typeof llm.default_model === "string" ? llm.default_model : "";
  const byDefault = visible.find((v) => v.id === defaultId);
  if (byDefault) return byDefault;

  const providerCfg = llmProviderConfig(llm, providerId);
  const legacy = [
    typeof providerCfg.model === "string" ? providerCfg.model.trim() : "",
    typeof llm.model === "string" ? llm.model.trim() : "",
  ].find((m) => m.length > 0);
  if (legacy) return visible.find((v) => v.id === legacy || viewRequestId(v) === legacy) ?? null;

  return visible[0] ?? null;
}

/** All visible LLM models across visible providers (default-model picker). */
export function allVisibleLlmModels(
  config: Rec,
  providers: RegistryProvider[],
  models: RegistryModel[],
): { provider: RegistryProvider; model: LlmModelView }[] {
  const llm = asRecord(config.llm);
  return visibleProviders(config, providers, models).flatMap((provider) =>
    visibleLlmModels(llm, provider.id, models).map((model) => ({ provider, model })),
  );
}

/* ======================================================================
   Credential values (two-scope reads)
   ====================================================================== */

/** Provider-wide shared credentials (model_providers.credentials.<id>). */
export function sharedCredentialValues(config: Rec, providerId: string): Rec {
  return asRecord(asRecord(asRecord(config.model_providers).credentials)[providerId]);
}

/** LLM capability credentials (llm.<provider>). */
export function llmCredentialValues(config: Rec, providerId: string): Rec {
  const legacy = asRecord(config.llm);
  const pc = llmProviderConfig(legacy, providerId);
  if (providerId === "custom_openai" && legacy.custom_openai != null) {
    return { url: pc.url ?? "", api_key: pc.api_key ?? "" };
  }
  return {
    url: pc.url || legacy.url || "",
    api_key: pc.api_key || legacy.api_key || "",
  };
}

/**
 * ASR capability credentials: canonical `audio.credentials.<provider>` layered
 * over legacy per-model blocks (matching resolve_model_config layers 3–4).
 */
export function asrCredentialValues(config: Rec, providerId: string, models: RegistryModel[]): Rec {
  const audio = asRecord(config.audio);
  const merged: Rec = {};
  for (const m of models) {
    if (m.provider !== providerId || m.category !== "asr") continue;
    Object.assign(merged, asRecord(audio[m.id]));
  }
  Object.assign(merged, asRecord(asRecord(audio.credentials)[providerId]));
  return merged;
}

/** Registry default for an ASR credential key (url default from the model). */
export function asrCredentialDefault(
  models: RegistryModel[],
  providerId: string,
  key: string,
): string {
  const preset = models.find((m) => m.provider === providerId && m.category === "asr");
  const value = preset?.default_config?.[key];
  return typeof value === "string" ? value : "";
}

/* ======================================================================
   Config patches (immutable updates over the raw config object)
   ====================================================================== */

function cloneConfig(config: Rec): Rec {
  return JSON.parse(JSON.stringify(config)) as Rec;
}

/** Add a provider to the visible list (initializes nothing else). */
export function withAddedProvider(
  config: Rec,
  providerId: string,
  models: RegistryModel[] = [],
): Rec {
  const next = cloneConfig(config);
  const added = new Set(addedProviderIds(config, models));
  if (added.has(providerId)) return next;
  const audio = asRecord(next.audio);
  const existingAsr =
    stringList(audio.models) ?? models.filter((m) => m.category === "asr").map((m) => m.id);
  const newProviderModels = new Set(
    models.filter((m) => m.provider === providerId && m.category === "asr").map((m) => m.id),
  );
  audio.models = existingAsr.filter((id) => !newProviderModels.has(id));
  next.audio = audio;
  const llm = asRecord(next.llm);
  if (
    llm[providerId] == null &&
    !(providerId === "custom_openai" && llm.openai_compatible != null)
  ) {
    llm[providerId] = { models: [] };
  }
  next.llm = llm;
  added.add(providerId);
  next.model_providers = { ...asRecord(next.model_providers), added: [...added] };
  return next;
}

/**
 * Remove a provider: drop it from the visible list and clear everything it
 * owns (LLM section + both credential scopes). If it carried a default
 * model, fall back: ASR → the first selectable model of remaining visible
 * providers; LLM → bytedance when visible, else the first remaining LLM
 * provider. Local providers keep downloaded model files on disk.
 */
export function withoutProvider(
  config: Rec,
  providerId: string,
  providers: RegistryProvider[],
  models: RegistryModel[],
  isAsrModelSelectable: (model: RegistryModel) => boolean = () => false,
): Rec {
  const next = cloneConfig(config);
  const added = new Set(addedProviderIds(config, models));
  added.delete(providerId);
  next.model_providers = { ...asRecord(next.model_providers), added: [...added] };
  const activeLlm = asRecord(next.llm).provider;
  const activeLlmId = typeof activeLlm === "string" ? canonicalProviderId(activeLlm) : "bytedance";

  // Clear LLM section + shared credentials.
  if (next.llm && typeof next.llm === "object") {
    const llm = next.llm as Rec;
    delete llm[providerId];
    if (providerId === "custom_openai") delete llm.openai_compatible;
    if (activeLlmId === providerId) {
      delete llm.url;
      delete llm.api_key;
      delete llm.model;
    }
  }
  const shared = asRecord(asRecord(next.model_providers).credentials);
  if (
    shared[providerId] !== undefined ||
    (providerId === "custom_openai" && shared.openai_compatible !== undefined)
  ) {
    next.model_providers = {
      ...asRecord(next.model_providers),
      credentials: Object.fromEntries(
        Object.entries(shared).filter(
          ([key]) =>
            key !== providerId && !(providerId === "custom_openai" && key === "openai_compatible"),
        ),
      ),
    };
  }

  // Clear ASR capability credentials.
  const audio = asRecord(next.audio);
  const creds = asRecord(audio.credentials);
  if (creds[providerId] !== undefined) {
    next.audio = {
      ...audio,
      credentials: Object.fromEntries(Object.entries(creds).filter(([key]) => key !== providerId)),
    };
  }
  const fields = providers.find((p) => p.id === providerId)?.credentials;
  const keys = [...(fields?.asr?.fields ?? []), ...(fields?.shared?.fields ?? [])].map(
    (f) => f.key,
  );
  const audioAfterCredentials = asRecord(next.audio);
  for (const model of models) {
    if (model.provider !== providerId || model.category !== "asr") continue;
    const block = audioAfterCredentials[model.id];
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    const updated = { ...asRecord(block) };
    for (const key of keys) delete updated[key];
    audioAfterCredentials[model.id] = updated;
  }

  const remaining = providers.filter((p) => added.has(p.id));

  // LLM default fallback.
  const llm = asRecord(next.llm);
  if (activeLlmId === providerId) {
    const fallback =
      remaining.find((p) => p.id === "bytedance" && p.capabilities.includes("llm")) ??
      remaining.find((p) => p.capabilities.includes("llm"));
    if (fallback) {
      next.llm = { ...llm, provider: fallback.id, default_model: "" };
    }
  }

  // ASR default fallback: the removed provider's active model reselects.
  const audioNow = asRecord(next.audio);
  const activeAsr =
    typeof audioNow.provider === "string" ? audioNow.provider : DOUBAO_FALLBACK_MODEL_ID;
  if (providerOfModel(models, activeAsr) === providerId) {
    const candidates = remaining
      .flatMap((p) => visibleAsrModels(audioNow, p.id, models))
      .filter((m) => m.type === "online" || isAsrModelSelectable(m));
    const fallback = candidates.find((m) => m.id === DOUBAO_FALLBACK_MODEL_ID) ?? candidates[0];
    next.audio = { ...audioNow, provider: fallback?.id ?? "" };
  }
  return next;
}

/**
 * Replace a provider's LLM model list. Clears the legacy single-model field
 * so it cannot override `default_model` (see llm.rs priority note).
 */
export function withLlmModels(
  config: Rec,
  providerId: string,
  entries: LlmModelEntry[],
  models: RegistryModel[] = [],
): Rec {
  const next = cloneConfig(config);
  const llm = asRecord(next.llm);
  const active =
    (typeof llm.provider === "string" ? canonicalProviderId(llm.provider) : "bytedance") ===
    providerId;
  const selected = active ? resolveDefaultLlmModel(llm, providerId, models) : null;
  migrateCustomProvider(llm, providerId);
  const providerCfg = llmProviderConfig(llm, providerId);
  const updated: Rec = { ...providerCfg, model: "", models: entries };
  next.llm = { ...llm, [providerId]: updated };
  const nextLlm = asRecord(next.llm);
  if (active) {
    if (selected && entries.some((entry) => entry.id === selected.id))
      nextLlm.default_model = selected.id;
    delete nextLlm.model;
  }
  return next;
}

/** Set the default LLM model (provider + model id written together). */
export function withDefaultLlmModel(config: Rec, providerId: string, modelId: string): Rec {
  const next = cloneConfig(config);
  const llm = asRecord(next.llm);
  migrateCustomProvider(llm, providerId);
  next.llm = { ...llm, provider: providerId, default_model: modelId };
  return next;
}

/** Update one ASR model's visibility in the positive list. */
export function withAsrModelVisible(
  config: Rec,
  modelId: string,
  visible: boolean,
  models: RegistryModel[],
  isAsrModelSelectable: (model: RegistryModel) => boolean = () => false,
): Rec {
  const next = cloneConfig(config);
  const audio = asRecord(next.audio);
  const list = stringList(audio.models);
  const current = new Set(list ?? models.filter((m) => m.category === "asr").map((m) => m.id));
  if (visible) current.add(modelId);
  else current.delete(modelId);
  const updatedAudio: Rec = { ...audio, models: [...current] };
  // Removing the active default model reselects a visible one.
  const activeAsr = typeof audio.provider === "string" ? audio.provider : DOUBAO_FALLBACK_MODEL_ID;
  if (!visible && activeAsr === modelId) {
    const added = new Set(addedProviderIds(config, models));
    const candidates = models.filter(
      (m) =>
        m.category === "asr" &&
        current.has(m.id) &&
        !!m.provider &&
        added.has(m.provider) &&
        (m.type === "online" || isAsrModelSelectable(m)),
    );
    const fallback = candidates.find((m) => m.id === DOUBAO_FALLBACK_MODEL_ID) ?? candidates[0];
    updatedAudio.provider = fallback?.id ?? "";
  }
  next.audio = updatedAudio;
  return next;
}

/** Write one ASR capability credential field (canonical location only). */
export function withAsrCredential(
  config: Rec,
  providerId: string,
  key: string,
  value: string,
  models: RegistryModel[],
): Rec {
  const next = cloneConfig(config);
  const audio = asRecord(next.audio);
  const creds = asRecord(audio.credentials);
  const providerCreds = asRecord(creds[providerId]);
  const updated: Rec = { ...providerCreds, [key]: value };
  next.audio = {
    ...audio,
    credentials: { ...creds, [providerId]: updated },
  };
  // Strip the stale legacy copy of the key from per-model blocks so the old
  // value cannot resurface (canonical wins in resolve_model_config anyway).
  for (const m of models) {
    if (m.provider !== providerId || m.category !== "asr") continue;
    const audioNow = asRecord(next.audio);
    const block = asRecord(audioNow[m.id]);
    if (block[key] !== undefined) {
      const rest = { ...block };
      delete rest[key];
      next.audio = { ...audioNow, [m.id]: rest };
    }
  }
  return next;
}

/** Update Doubao's base while preserving the effective legacy recognition mode. */
export function withDoubaoBaseUrl(config: Rec, value: string): Rec {
  const next = cloneConfig(config);
  const audio = asRecord(next.audio);
  const credentials = asRecord(audio.credentials);
  const bytedance = { ...asRecord(credentials.bytedance) };
  const model = { ...asRecord(audio[DOUBAO_FALLBACK_MODEL_ID]) };
  const previous = String(
    bytedance.url_base ? model.url || bytedance.url || "" : bytedance.url || model.url || "",
  );
  if (previous) {
    const mode = previous.replace(/\/$/, "").endsWith("/bigmodel_nostream")
      ? "bigmodel_nostream"
      : "bigmodel_async";
    model.url = `wss://openspeech.bytedance.com/api/v3/sauc/${mode}`;
  }
  delete bytedance.url;
  bytedance.url_base = value
    .trim()
    .replace(/\/bigmodel_(async|nostream)\/?$/, "")
    .replace(/\/$/, "");
  next.audio = {
    ...audio,
    [DOUBAO_FALLBACK_MODEL_ID]: model,
    credentials: { ...credentials, bytedance },
  };
  return next;
}

/** Write one LLM capability credential field. */
export function withLlmCredential(
  config: Rec,
  providerId: string,
  key: "url" | "api_key",
  value: string,
): Rec {
  const next = cloneConfig(config);
  const llm = asRecord(next.llm);
  migrateCustomProvider(llm, providerId);
  const providerCfg = llmProviderConfig(llm, providerId);
  next.llm = { ...llm, [providerId]: { ...providerCfg, [key]: value } };
  return next;
}

/** Write one shared (provider-wide) credential field. */
export function withSharedCredential(
  config: Rec,
  providerId: string,
  key: "url" | "api_key",
  value: string,
): Rec {
  const next = cloneConfig(config);
  const mp = asRecord(next.model_providers);
  const creds = asRecord(mp.credentials);
  const providerCreds = asRecord(creds[providerId]);
  next.model_providers = {
    ...mp,
    credentials: { ...creds, [providerId]: { ...providerCreds, [key]: value } },
  };
  return next;
}
