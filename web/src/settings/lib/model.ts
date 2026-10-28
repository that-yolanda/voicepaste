/**
 * ASR model config utilities.
 *
 * Three orthogonal sources drive the unified model config UI:
 * - registry.json `default_config` → field VALUES (defaults + presence + order)
 * - backend `getAudioConfigDefaults()` → shared global defaults (AsrDefaults)
 * - this module's `FIELD_META` → field RENDERING (label / control / options / group)
 *
 * No per-model branching: any model using a key automatically gets correct
 * rendering via FIELD_META; unknown keys fall back to a sensible default.
 */

import type { TFunction } from "i18next";
import type { RegistryModel } from "@/settings/types/models";

export const DOUBAO_MODEL_ID = "doubao-streaming";
export const ELEVENLABS_MODEL_ID = "elevenlabs-realtime";

/* ---------- Control types & field metadata ---------- */

export type ControlType =
  | "text"
  | "password"
  | "number"
  | "toggle"
  | "segment"
  | "textarea"
  | "list";

/** Visual grouping for rendered config fields. */
export type FieldGroup = "credentials" | "basic" | "shared" | "advanced";

export interface SegmentOption {
  value: string;
  label: string;
}

export interface FieldMeta {
  /** Display label (Chinese; structured for future i18n migration). */
  label: string;
  /** Control type. Omit to infer from the field value. */
  type?: ControlType;
  /** Options for `segment` controls. */
  options?: SegmentOption[];
  placeholder?: string;
  /** Step for `number` controls. Defaults to integer/float heuristic. */
  step?: number;
  group?: FieldGroup;
  description?: string;
  tooltip?: string;
  maxLength?: number;
  min?: number;
  max?: number;
}

/** Enum option lists shared across models. `label` stores the i18n key. */
export const HOTWORD_MODE_OPTS: SegmentOption[] = [
  { value: "auto", label: "field.hotword_llm_mode.options.auto" },
  { value: "disabled", label: "field.hotword_llm_mode.options.disabled" },
  { value: "force", label: "field.hotword_llm_mode.options.force" },
];

export const PROVIDER_OPTS: SegmentOption[] = [
  { value: "cpu", label: "field.provider.options.cpu" },
  { value: "cuda", label: "field.provider.options.cuda" },
  { value: "coreml", label: "field.provider.options.coreml" },
];

export const PUNCT_OPTS: SegmentOption[] = [
  { value: "auto", label: "field.punctuation_mode.options.auto" },
  { value: "disabled", label: "field.punctuation_mode.options.disabled" },
  { value: "force", label: "field.punctuation_mode.options.force" },
];

/**
 * Key → rendering metadata. Covers every key appearing in registry.json
 * `default_config` plus the shared asr_defaults fields. Keys absent here
 * fall back via `getFieldMeta` (label = key with underscores → spaces,
 * control type inferred from value).
 */
export const FIELD_META: Record<string, FieldMeta> = {
  /* Shared asr_defaults params */
  stream_simulate: { label: "field.stream_simulate", type: "toggle", group: "shared" },
  hotword_llm_mode: {
    label: "field.hotword_llm_mode",
    type: "segment",
    options: HOTWORD_MODE_OPTS,
    group: "shared",
  },
  hotword_replace: { label: "field.hotword_replace", type: "toggle", group: "shared" },
  num_threads: { label: "field.num_threads", type: "number", group: "shared" },
  provider: {
    label: "field.provider",
    type: "segment",
    options: PROVIDER_OPTS,
    group: "shared",
  },
  punctuation_mode: {
    label: "field.punctuation_mode",
    type: "segment",
    options: PUNCT_OPTS,
    group: "shared",
  },

  /* VAD params */
  threshold: { label: "field.threshold", type: "number", step: 0.1, group: "shared" },
  min_silence_duration: {
    label: "field.min_silence_duration",
    type: "number",
    step: 0.1,
    group: "shared",
  },
  min_speech_duration: {
    label: "field.min_speech_duration",
    type: "number",
    step: 0.1,
    group: "shared",
  },
  max_speech_duration: {
    label: "field.max_speech_duration",
    type: "number",
    step: 0.1,
    group: "shared",
  },

  /* Doubao credentials */
  auth_mode: {
    label: "field.auth_mode",
    type: "segment",
    options: [
      { value: "legacy", label: "field.auth_mode.options.legacy" },
      { value: "v2", label: "field.auth_mode.options.v2" },
    ],
    group: "credentials",
  },
  url: {
    label: "field.url",
    type: "text",
    placeholder: "field.url.placeholder",
    group: "credentials",
  },
  app_id: { label: "field.app_id", group: "credentials", placeholder: "field.app_id.placeholder" },
  access_token: {
    label: "field.access_token",
    type: "password",
    group: "credentials",
    placeholder: "field.access_token.placeholder",
  },
  resource_id: {
    label: "field.resource_id",
    group: "credentials",
    placeholder: "field.resource_id.placeholder",
  },
  api_key: {
    label: "field.api_key",
    type: "password",
    group: "credentials",
    placeholder: "field.api_key.placeholder",
  },

  /* Doubao basic settings & feature toggles & advanced / internal params */
  enable_nonstream: { label: "field.enable_nonstream", type: "toggle", group: "advanced" },
  enable_accelerate_text: {
    label: "field.enable_accelerate_text",
    type: "toggle",
    group: "advanced",
  },
  enable_ddc: { label: "field.enable_ddc", type: "toggle", group: "advanced" },
  enable_itn: { label: "field.enable_itn", type: "toggle", group: "advanced" },
  enable_punc: { label: "field.enable_punc", type: "toggle", group: "advanced" },
  "corpus.boosting_table_id": {
    label: "field.corpus.boosting_table_id",
    group: "advanced",
    placeholder: "field.corpus.boosting_table_id.placeholder",
  },
  "corpus.correct_table_id": {
    label: "field.corpus.correct_table_id",
    group: "advanced",
    placeholder: "field.corpus.correct_table_id.placeholder",
  },
  language: {
    label: "field.language",
    type: "text",
    placeholder: "field.language.placeholder",
    group: "advanced",
  },
  rate: { label: "field.rate", type: "number", group: "advanced" },
  channel: { label: "field.channel", type: "number", group: "advanced" },
  format: { label: "field.format", group: "advanced" },
  bits: { label: "field.bits", type: "number", group: "advanced" },
  model_name: { label: "field.model_name", group: "advanced" },
  model_version: { label: "field.model_version", group: "advanced" },
  operation: { label: "field.operation", group: "advanced" },
  sequence: { label: "field.sequence", type: "number", group: "advanced" },
  show_utterances: { label: "field.show_utterances", type: "toggle", group: "advanced" },
  result_type: {
    label: "field.result_type",
    type: "segment",
    options: [
      { value: "full", label: "field.result_type.options.full" },
      { value: "single", label: "field.result_type.options.single" },
    ],
    group: "advanced",
  },
  accelerate_score: { label: "field.accelerate_score", type: "number", group: "advanced" },
  ssd_version: {
    label: "field.ssd_version",
    type: "segment",
    options: [
      { value: "200", label: "field.ssd_version.options.200" },
      { value: "100", label: "field.ssd_version.options.100" },
    ],
    group: "advanced",
  },
  output_zh_variant: {
    label: "field.output_zh_variant",
    type: "segment",
    options: [
      { value: "off", label: "field.output_zh_variant.options.off" },
      { value: "traditional", label: "field.output_zh_variant.options.traditional" },
      { value: "tw", label: "field.output_zh_variant.options.tw" },
      { value: "hk", label: "field.output_zh_variant.options.hk" },
    ],
    group: "advanced",
  },
  end_window_size: { label: "field.end_window_size", type: "number", group: "advanced" },
  force_to_speech_time: {
    label: "field.force_to_speech_time",
    type: "number",
    group: "advanced",
  },
  vad_segment_duration: {
    label: "field.vad_segment_duration",
    type: "number",
    group: "advanced",
  },

  /* Offline model params */
  use_itn: { label: "field.use_itn", type: "toggle", group: "basic" },
  itn: { label: "field.itn", type: "toggle", group: "basic" },
  system_prompt: { label: "field.system_prompt", type: "textarea", group: "basic" },
  user_prompt: { label: "field.user_prompt", type: "textarea", group: "basic" },
  max_new_tokens: { label: "field.max_new_tokens", type: "number", group: "basic" },
  temperature: { label: "field.temperature", type: "number", step: 0.1, group: "basic" },
  top_p: { label: "field.top_p", type: "number", step: 0.1, group: "basic" },
  seed: { label: "field.seed", type: "number", group: "basic" },
  max_active_paths: { label: "field.max_active_paths", type: "number", group: "basic" },
  modeling_unit: { label: "field.modeling_unit", type: "text", group: "basic" },
  max_total_len: { label: "field.max_total_len", type: "number", group: "basic" },
  enable_endpoint: { label: "field.enable_endpoint", type: "toggle", group: "basic" },
  rule1_min_trailing_silence: {
    label: "field.rule1_min_trailing_silence",
    type: "number",
    step: 0.1,
    group: "basic",
  },
  rule2_min_trailing_silence: {
    label: "field.rule2_min_trailing_silence",
    type: "number",
    step: 0.1,
    group: "basic",
  },
  rule3_min_utterance_length: {
    label: "field.rule3_min_utterance_length",
    type: "number",
    group: "basic",
  },
};

const ELEVENLABS_FIELDS: Record<string, Partial<FieldMeta>> = {
  api_key: {},
  enable_ddc: {
    group: "basic",
    tooltip: "field.enable_ddc.tooltip",
  },
  enable_keyterms: {
    label: "field.enable_keyterms",
    type: "toggle",
    group: "basic",
    tooltip: "field.enable_keyterms.tooltip",
    description: "field.enable_keyterms.description",
  },
  commit_strategy: {
    label: "field.commit_strategy",
    type: "segment",
    group: "basic",
    options: [
      { value: "manual", label: "field.commit_strategy.options.manual" },
      { value: "vad", label: "field.commit_strategy.options.vad" },
    ],
    tooltip: "field.commit_strategy.tooltip",
  },
  language: { group: "advanced", tooltip: "field.language.tooltip" },
  secondary_languages: {
    label: "field.secondary_languages",
    type: "list",
    group: "advanced",
    placeholder: "field.secondary_languages.placeholder",
    tooltip: "field.secondary_languages.tooltip",
  },
  filter_background_audio: {
    label: "field.filter_background_audio",
    type: "toggle",
    group: "advanced",
    tooltip: "field.filter_background_audio.tooltip",
  },
  transcript_edit: {
    label: "field.transcript_edit",
    type: "textarea",
    group: "advanced",
    maxLength: 2000,
    placeholder: "field.transcript_edit.placeholder",
    tooltip: "field.transcript_edit.tooltip",
    description: "field.transcript_edit.description",
  },
  vad_silence_threshold_secs: {
    label: "field.vad_silence_threshold_secs",
    type: "number",
    group: "advanced",
    min: 0.3,
    max: 3,
    step: 0.1,
    tooltip: "field.vad_silence_threshold_secs.tooltip",
  },
  vad_threshold: {
    label: FIELD_META.threshold.label,
    type: "number",
    group: "advanced",
    min: 0.1,
    max: 0.9,
    step: 0.1,
    tooltip: "field.vad_threshold.tooltip",
  },
  min_speech_duration_ms: {
    label: "field.min_speech_duration_ms",
    type: "number",
    group: "advanced",
    min: 50,
    max: 2000,
    step: 1,
    tooltip: "field.min_speech_duration_ms.tooltip",
  },
  min_silence_duration_ms: {
    label: "field.min_silence_duration_ms",
    type: "number",
    group: "advanced",
    min: 50,
    max: 2000,
    step: 1,
    tooltip: "field.min_silence_duration_ms.tooltip",
  },
};

export function parseLanguageList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[,，]/)
        .map((code) => code.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

export function isModelFieldVisible(
  modelId: string,
  key: string,
  config: Record<string, unknown>,
): boolean {
  return (
    modelId !== ELEVENLABS_MODEL_ID ||
    config.commit_strategy !== "manual" ||
    ![
      "vad_silence_threshold_secs",
      "vad_threshold",
      "min_speech_duration_ms",
      "min_silence_duration_ms",
    ].includes(key)
  );
}

export function credentialHelpUrl(modelId: string): string {
  return modelId === ELEVENLABS_MODEL_ID
    ? "https://voicepaste.dev/docs/api/elevenlabs"
    : "https://voicepaste.dev/docs/api/volcengine";
}

/** Infer a control type from the value when FIELD_META omits `type`. */
export function inferControlType(key: string, value: unknown): ControlType {
  if (typeof value === "boolean") return "toggle";
  if (typeof value === "number") return "number";
  if (key.includes("prompt")) return "textarea";
  if (/(token|secret|password)/i.test(key)) return "password";
  return "text";
}

/** Resolve rendering metadata for a key, falling back for unknown keys. */
export function getFieldMeta(key: string, value: unknown, modelId?: string): FieldMeta {
  // Try the full key first, then the last segment after a dot
  // (e.g. "vad.threshold" → "threshold") so nested asr_defaults keys resolve.
  const meta = FIELD_META[key] ?? FIELD_META[key.split(".").pop() ?? ""];
  const override = modelId === ELEVENLABS_MODEL_ID ? ELEVENLABS_FIELDS[key] : undefined;
  if (meta || override) return { ...(meta ?? { label: key }), ...override };
  return {
    label: key.replace(/_/g, " "),
    type: inferControlType(key, value),
    group: "basic",
  };
}

/**
 * Resolve a field's metadata to display strings for the active language.
 * `getFieldMeta` returns i18n keys; pass this result through `t` before
 * rendering so labels/placeholders/tooltips/options follow the UI language.
 * Unknown keys (the underscore fallback) resolve to their own text.
 */
export function resolveFieldMeta(meta: FieldMeta, t: TFunction): FieldMeta {
  return {
    ...meta,
    label: t(meta.label),
    placeholder: meta.placeholder ? t(meta.placeholder) : undefined,
    tooltip: meta.tooltip ? t(meta.tooltip) : undefined,
    description: meta.description ? t(meta.description) : undefined,
    options: meta.options?.map((option) => ({ ...option, label: t(option.label) })),
  };
}

/* ---------- Config merging (mirrors backend base + override semantics) ---------- */

export interface AsrDefaults {
  rate: number;
  channel: number;
  stream_simulate: boolean;
  hotword_llm_mode: string;
  hotword_replace: boolean;
  num_threads: number;
  provider: string;
  punctuation_mode: string;
  vad: {
    threshold: number;
    min_silence_duration: number;
    min_speech_duration: number;
    max_speech_duration: number;
  };
}

/** Merge asr_defaults: backend defaults (`AsrDefaults::default()`) as base,
 *  with user-saved values from `audio.asr_defaults` overriding per field.
 *  This is what the CustomConfigModal should display — NOT the raw backend
 *  defaults, otherwise saved edits never reflect back in the UI. */
export function mergeAsrDefaults(base: AsrDefaults, saved: unknown): AsrDefaults {
  const s =
    saved && typeof saved === "object" && !Array.isArray(saved)
      ? (saved as Record<string, unknown>)
      : {};
  const sv =
    s.vad && typeof s.vad === "object" && !Array.isArray(s.vad)
      ? (s.vad as Record<string, unknown>)
      : {};
  const num = (v: unknown, fb: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : fb;
  const str = (v: unknown, fb: string): string => (typeof v === "string" && v.trim() ? v : fb);
  const bool = (v: unknown, fb: boolean): boolean => (typeof v === "boolean" ? v : fb);
  return {
    rate: num(s.rate, base.rate),
    channel: num(s.channel, base.channel),
    stream_simulate: bool(s.stream_simulate, base.stream_simulate),
    hotword_llm_mode: str(s.hotword_llm_mode, base.hotword_llm_mode),
    hotword_replace: bool(s.hotword_replace, base.hotword_replace),
    num_threads: num(s.num_threads, base.num_threads),
    provider: str(s.provider, base.provider),
    punctuation_mode: str(s.punctuation_mode, base.punctuation_mode),
    vad: {
      threshold: num(sv.threshold, base.vad.threshold),
      min_silence_duration: num(sv.min_silence_duration, base.vad.min_silence_duration),
      min_speech_duration: num(sv.min_speech_duration, base.vad.min_speech_duration),
      max_speech_duration: num(sv.max_speech_duration, base.vad.max_speech_duration),
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A flattened config field (nested objects expanded to `parent.child` keys). */
export interface MergedField {
  key: string;
  value: unknown;
}

/**
 * Compute a model's effective flattened config fields:
 * registry default_config → (audio params from asr_defaults) → user overrides.
 * Most shared asr_defaults fields (num_threads/provider/hotword/vad/...) are
 * managed globally via the CustomConfigModal, NOT per-model. Audio capture
 * params (rate/channel) are the exception: they reuse asr_defaults so the
 * per-model panel stays in sync with the "音频采样" section.
 */
export function getMergedAsrConfig(
  model: RegistryModel,
  userConfig: Record<string, unknown> | undefined,
  asrDefaults?: AsrDefaults | null,
): MergedField[] {
  const base = asRecord(model.default_config);
  const user = asRecord(userConfig);

  // Merge: base keeps its natural order; user overrides last.
  const merged: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(base)) merged[k] = v;
  if (asrDefaults) {
    if ("rate" in merged) merged.rate = asrDefaults.rate;
    if ("channel" in merged) merged.channel = asrDefaults.channel;
  }
  for (const [k, v] of Object.entries(user)) merged[k] = v;

  // Flatten one level of nested objects (e.g. corpus → corpus.boosting_table_id).
  const fields: MergedField[] = [];
  for (const [k, v] of Object.entries(merged)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [child, childVal] of Object.entries(v as Record<string, unknown>)) {
        fields.push({ key: `${k}.${child}`, value: childVal });
      }
    } else {
      fields.push({ key: k, value: v });
    }
  }

  // Order by FIELD_META definition order (frontend-controlled, stable) so display
  // order doesn't depend on backend serialization of config.yaml / registry.
  // Keys absent from FIELD_META sort last, preserving their relative order.
  const fieldOrder = Object.keys(model.id === ELEVENLABS_MODEL_ID ? ELEVENLABS_FIELDS : FIELD_META);
  fields.sort((a, b) => {
    const ia = fieldOrder.indexOf(a.key);
    const ib = fieldOrder.indexOf(b.key);
    if (ia === -1 && ib === -1) return 0;
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
  return fields;
}

/* ---------- Doubao auth-mode helpers (mirror backend effective_auth_mode) ---------- */

/**
 * True if the user has legacy Doubao credentials (App ID or Access Token) saved
 * locally. Drives whether the auth-mode toggle is shown: existing users get the
 * toggle, brand-new users see only the API Key field.
 */
export function hasLegacyDoubaoCreds(userConfig: Record<string, unknown> | undefined): boolean {
  if (!userConfig) return false;
  const app = String(userConfig.app_id ?? "").trim();
  const tok = String(userConfig.access_token ?? "").trim();
  return app.length > 0 || tok.length > 0;
}

/**
 * Effective Doubao auth mode: an explicit saved value wins; otherwise fall back
 * to v2 for users without legacy creds (new users) and legacy for users who
 * already have App ID / Access Token. Mirrors the backend fallback so the UI
 * matches the headers actually sent.
 */
export function effectiveDoubaoAuthMode(
  userConfig: Record<string, unknown> | undefined,
): "legacy" | "v2" {
  const explicit = String(userConfig?.auth_mode ?? "").trim();
  if (explicit === "v2" || explicit === "legacy") return explicit;
  return hasLegacyDoubaoCreds(userConfig) ? "legacy" : "v2";
}
