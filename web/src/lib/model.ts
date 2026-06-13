/**
 * ASR model config utilities extracted from settings.js.
 */

/** Deep-clone a plain value via JSON round-trip. Returns {} for falsy input. */
function clonePlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value || {}));
}

// ---- Model registry types (minimal inline; full types in @/types/models.ts) ----

export interface RegistryModel {
  id: string;
  name: string;
  type: string;
  category?: string;
  description?: string;
  mem_size?: number;
  languages?: string[];
  capabilities?: Record<string, boolean>;
  default_config?: Record<string, unknown>;
  file_size?: number;
}

export const DOUBAO_MODEL_ID = "doubao-streaming";

export const MODEL_PARAM_LABELS: Record<string, string> = {
  format: "音频格式",
  rate: "采样率",
  bits: "采样位数",
  channel: "声道数",
  model_name: "模型名称",
  model_version: "模型版本",
  operation: "操作类型",
  sequence: "请求序号",
  show_utterances: "显示分句",
  result_type: "结果类型",
  enable_accelerate_text: "启用文本加速",
  accelerate_score: "加速分数",
  vad_segment_duration: "VAD 分段时长",
  end_window_size: "结束窗口",
  force_to_speech_time: "强制语音时间",
};

// Visible params for the Doubao streaming model
export const DOUBAO_VISIBLE_PARAMS = new Set([
  "url",
  "app_id",
  "access_token",
  "secret_key",
  "resource_id",
  "language",
  "enable_ddc",
  "enable_itn",
  "enable_nonstream",
  "enable_punc",
  "corpus",
]);

/** Get the currently active ASR provider from config. */
export function getAsrProvider(config?: { audio?: { provider?: string } }): string {
  return config?.audio?.provider || DOUBAO_MODEL_ID;
}

/** Look up a model in the registry by id. */
export function getRegistryModel(
  modelId: string,
  registry: RegistryModel[] | null,
): RegistryModel | null {
  if (!Array.isArray(registry)) return null;
  return registry.find((entry) => entry.id === modelId) ?? null;
}

/** Return the default config for a model (deep clone). */
export function defaultModelConfig(
  modelId: string,
  registry: RegistryModel[] | null,
): Record<string, unknown> {
  return clonePlain(getRegistryModel(modelId, registry)?.default_config || {});
}

/** Ensure a config has the model's section and return it. */
export function ensureModelConfig<T extends { audio?: Record<string, unknown> }>(
  config: T,
  modelId: string,
  registry: RegistryModel[] | null,
): Record<string, unknown> {
  config.audio = config.audio || {};
  if (!config.audio[modelId] || typeof config.audio[modelId] !== "object") {
    config.audio[modelId] = defaultModelConfig(modelId, registry);
  }
  return config.audio[modelId] as Record<string, unknown>;
}

/** Merge default + user config for a model. */
export function getMergedModelConfig(
  config: { audio?: Record<string, unknown> },
  modelId: string,
  registry: RegistryModel[] | null,
): Record<string, unknown> {
  return {
    ...defaultModelConfig(modelId, registry),
    ...(config.audio?.[modelId] || {}),
  } as Record<string, unknown>;
}

/** Human-readable label for a model config key. */
export function labelForModelParam(key: string): string {
  return MODEL_PARAM_LABELS[key] || key.replace(/_/g, " ");
}

/** Read a model config value from a form input element. */
export function readModelParamInput(
  input: HTMLInputElement,
): boolean | number | string | undefined {
  if (input.dataset.valueType === "boolean") return input.checked;
  if (input.dataset.valueType === "number") {
    const val = parseFloat(input.value);
    return Number.isNaN(val) ? undefined : val;
  }
  return input.value.trim();
}

/**
 * Render model config rows as HTML strings.
 * (Will be replaced by React components in Phase 5; kept as a pure function
 * for now so existing code can use it.)
 */
export function renderModelConfigRows(modelId: string, values: Record<string, unknown>): string {
  return Object.entries(values || {})
    .map(([key, value]) => {
      const label = escapeFn(labelForModelParam(key));
      const escapedKey = escapeFn(key);
      const escapedId = escapeFn(modelId);
      const row = "flex items-center gap-3 py-[5px]";
      const labelCls = "text-xs text-text-dim shrink-0 min-w-[100px]";
      const inputCls =
        "flex-1 min-w-0 h-[34px] px-3 border border-border rounded-[6px] bg-input-bg text-text text-sm outline-none";
      if (typeof value === "boolean") {
        return `<div class="${row}"><span class="${labelCls}">${label}</span><label class="relative w-[38px] h-[22px] shrink-0 cursor-pointer inline-flex"><input type="checkbox" class="peer hidden model-param" data-model-id="${escapedId}" data-param="${escapedKey}" data-value-type="boolean" ${value ? "checked" : ""} /><span class="absolute inset-0 bg-fill-track rounded-[20px] peer-checked:bg-accent transition-colors duration-200"></span><span class="absolute top-[2px] left-[2px] w-[18px] h-[18px] bg-white rounded-full peer-checked:translate-x-[16px] transition-transform duration-200 shadow-[0_1px_2px_rgba(0,0,0,0.15)]"></span></label></div>`;
      }
      if (typeof value === "number") {
        return `<div class="${row}"><span class="${labelCls}">${label}</span><input type="number" class="${inputCls} model-param" data-model-id="${escapedId}" data-param="${escapedKey}" data-value-type="number" value="${escapeFn(String(value))}" step="0.1" /></div>`;
      }
      return `<div class="${row}"><span class="${labelCls}">${label}</span><input type="text" class="${inputCls} model-param" data-model-id="${escapedId}" data-param="${escapedKey}" data-value-type="string" value="${escapeFn(String(value ?? ""))}" /></div>`;
    })
    .join("");
}

// Local copy to avoid circular imports from format.ts
function escapeFn(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
