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

import type { RegistryModel } from "@/types/models";

export const DOUBAO_MODEL_ID = "doubao-streaming";

/* ---------- Control types & field metadata ---------- */

export type ControlType = "text" | "password" | "number" | "toggle" | "segment" | "textarea";

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
}

/** Enum option lists shared across models. */
export const HOTWORD_MODE_OPTS: SegmentOption[] = [
  { value: "auto", label: "自动" },
  { value: "disabled", label: "关闭" },
  { value: "force", label: "开启" },
];

export const PROVIDER_OPTS: SegmentOption[] = [
  { value: "cpu", label: "CPU" },
  { value: "cuda", label: "CUDA" },
  { value: "coreml", label: "CoreML" },
];

export const PUNCT_OPTS: SegmentOption[] = [
  { value: "auto", label: "自适应" },
  { value: "disabled", label: "禁用" },
  { value: "force", label: "强制启用" },
];

/**
 * Key → rendering metadata. Covers every key appearing in registry.json
 * `default_config` plus the shared asr_defaults fields. Keys absent here
 * fall back via `getFieldMeta` (label = key with underscores → spaces,
 * control type inferred from value).
 */
export const FIELD_META: Record<string, FieldMeta> = {
  /* Shared asr_defaults params */
  stream_simulate: { label: "模拟流式输出", type: "toggle", group: "shared" },
  hotword_llm_mode: {
    label: "热词强化",
    type: "segment",
    options: HOTWORD_MODE_OPTS,
    group: "shared",
  },
  hotword_replace: { label: "热词替换", type: "toggle", group: "shared" },
  num_threads: { label: "线程数", type: "number", group: "shared" },
  provider: {
    label: "推理后端",
    type: "segment",
    options: PROVIDER_OPTS,
    group: "shared",
  },
  punctuation_mode: {
    label: "标点符号",
    type: "segment",
    options: PUNCT_OPTS,
    group: "shared",
  },

  /* VAD params */
  threshold: { label: "VAD 阈值", type: "number", step: 0.1, group: "shared" },
  min_silence_duration: {
    label: "VAD 最小静音时长",
    type: "number",
    step: 0.1,
    group: "shared",
  },
  min_speech_duration: {
    label: "VAD 最小说话时长",
    type: "number",
    step: 0.1,
    group: "shared",
  },
  max_speech_duration: {
    label: "VAD 最大说话时长",
    type: "number",
    step: 0.1,
    group: "shared",
  },

  /* Doubao credentials */
  url: {
    label: "WebSocket 地址",
    type: "text",
    placeholder: "wss://...",
    group: "credentials",
  },
  app_id: { label: "App ID", group: "credentials", placeholder: "输入 App ID" },
  access_token: {
    label: "Access Token",
    type: "password",
    group: "credentials",
    placeholder: "输入 Access Token",
  },
  secret_key: {
    label: "Secret Key",
    type: "password",
    group: "credentials",
    placeholder: "输入 Secret Key",
  },
  resource_id: {
    label: "Resource ID",
    group: "credentials",
    placeholder: "输入 Resource ID",
  },

  /* Doubao basic settings & feature toggles & advanced / internal params */
  enable_nonstream: { label: "二遍识别", type: "toggle", group: "advanced" },
  enable_accelerate_text: {
    label: "首字加速",
    type: "toggle",
    group: "advanced",
  },
  enable_ddc: { label: "语义顺滑", type: "toggle", group: "advanced" },
  enable_itn: { label: "数字格式化", type: "toggle", group: "advanced" },
  enable_punc: { label: "自动标点", type: "toggle", group: "advanced" },
  "corpus.boosting_table_id": {
    label: "热词表 ID",
    group: "advanced",
    placeholder: "输入热词表 ID",
  },
  "corpus.correct_table_id": {
    label: "替换词表 ID",
    group: "advanced",
    placeholder: "输入替换词表 ID",
  },
  language: {
    label: "语言",
    type: "text",
    placeholder: "留空则自动检测",
    group: "advanced",
  },
  rate: { label: "音频采样", type: "number", group: "advanced" },
  channel: { label: "声道", type: "number", group: "advanced" },
  format: { label: "音频格式", group: "advanced" },
  bits: { label: "采样位数", type: "number", group: "advanced" },
  model_name: { label: "模型名称", group: "advanced" },
  model_version: { label: "模型版本", group: "advanced" },
  operation: { label: "操作类型", group: "advanced" },
  sequence: { label: "请求序号", type: "number", group: "advanced" },
  show_utterances: { label: "显示分句", type: "toggle", group: "advanced" },
  result_type: {
    label: "结果返回方式",
    type: "segment",
    options: [
      { value: "full", label: "全量" },
      { value: "single", label: "增量" },
    ],
    group: "advanced",
  },
  accelerate_score: { label: "首字加速率", type: "number", group: "advanced" },
  ssd_version: {
    label: "SSD 大模型版本",
    type: "segment",
    options: [
      { value: "200", label: "200（大模型 SSD）" },
      { value: "100", label: "100（标准）" },
    ],
    group: "advanced",
  },
  output_zh_variant: {
    label: "繁体输出",
    type: "segment",
    options: [
      { value: "off", label: "不转换" },
      { value: "traditional", label: "繁体（大陆）" },
      { value: "tw", label: "台湾正体" },
      { value: "hk", label: "香港繁体" },
    ],
    group: "advanced",
  },
  end_window_size: { label: "强制判停时长 (ms)", type: "number", group: "advanced" },
  force_to_speech_time: { label: "最短强制判停 (ms)", type: "number", group: "advanced" },
  vad_segment_duration: {
    label: "语义切句静音阈值 (ms)",
    type: "number",
    group: "advanced",
  },

  /* Offline model params */
  use_itn: { label: "数字格式化 (ITN)", type: "toggle", group: "basic" },
  itn: { label: "ITN", type: "toggle", group: "basic" },
  system_prompt: { label: "系统提示词", type: "textarea", group: "basic" },
  user_prompt: { label: "用户提示词", type: "textarea", group: "basic" },
  max_new_tokens: { label: "最大生成 Token", type: "number", group: "basic" },
  temperature: { label: "采样温度", type: "number", step: 0.1, group: "basic" },
  top_p: { label: "Top-P", type: "number", step: 0.1, group: "basic" },
  seed: { label: "随机种子", type: "number", group: "basic" },
  max_active_paths: { label: "最大活跃路径", type: "number", group: "basic" },
  modeling_unit: { label: "建模单元", type: "text", group: "basic" },
  max_total_len: { label: "最大总长度", type: "number", group: "basic" },
  enable_endpoint: { label: "端点检测", type: "toggle", group: "basic" },
  rule1_min_trailing_silence: {
    label: "规则1最小尾静音",
    type: "number",
    step: 0.1,
    group: "basic",
  },
  rule2_min_trailing_silence: {
    label: "规则2最小尾静音",
    type: "number",
    step: 0.1,
    group: "basic",
  },
  rule3_min_utterance_length: {
    label: "规则3最短话语长度",
    type: "number",
    group: "basic",
  },
};

/** Infer a control type from the value when FIELD_META omits `type`. */
export function inferControlType(key: string, value: unknown): ControlType {
  if (typeof value === "boolean") return "toggle";
  if (typeof value === "number") return "number";
  if (key.includes("prompt")) return "textarea";
  if (/(token|secret|password)/i.test(key)) return "password";
  return "text";
}

/** Resolve rendering metadata for a key, falling back for unknown keys. */
export function getFieldMeta(key: string, value: unknown): FieldMeta {
  // Try the full key first, then the last segment after a dot
  // (e.g. "vad.threshold" → "threshold") so nested asr_defaults keys resolve.
  const meta = FIELD_META[key] ?? FIELD_META[key.split(".").pop() ?? ""];
  if (meta) return meta;
  return {
    label: key.replace(/_/g, " "),
    type: inferControlType(key, value),
    group: "basic",
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
  const fieldOrder = Object.keys(FIELD_META);
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
