import {
  CircleCheck,
  CircleX,
  CloudDownload,
  Cog,
  LoaderCircle,
  RotateCcw,
  Trash,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  deleteModel,
  downloadModel,
  getDownloadedModels,
  getModelRegistry,
  type ModelDownloadProgress,
  onModelDownloadProgress,
  saveConfigObject,
} from "@/bridge/settings";
import { clonePlain } from "@/lib/clone";
import {
  DOUBAO_MODEL_ID,
  DOUBAO_VISIBLE_PARAMS,
  type RegistryModel,
} from "@/lib/model";
import { Button } from "@/ui/components/Button";
import { Modal } from "@/ui/components/Modal";
import { SegmentedControl } from "@/ui/components/SegmentedControl";
import { Toggle } from "@/ui/components/Toggle";
import {
  PageHeader,
  PageLayout,
  Section,
  SectionContent,
  SectionHeader,
} from "@/ui/layout/PageLayout";
import { useSettings } from "@/ui/SettingsProvider";

const VAD_ID = "silero-vad";
const ASR_DEFAULTS_ID = "asr_defaults";

const DEFAULT_ASR_CONFIG = {
  rate: 16000,
  channel: 1,
  stream_simulate: true,
  hotword_llm_mode: "auto",
  hotword_replace: true,
  num_threads: 2,
  provider: "cpu",
  punctuation_mode: "auto",
  vad: {
    max_speech_duration: 10,
    min_speech_duration: 0.2,
    min_silence_duration: 0.2,
    threshold: 0.2,
  },
};

const COMMON_MODEL_KEYS = new Set([
  "rate",
  "channel",
  "stream_simulate",
  "hotword_llm_mode",
  "hotword_replace",
  "num_threads",
  "provider",
  "punctuation_mode",
  "threshold",
  "min_silence_duration",
  "min_speech_duration",
  "max_speech_duration",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function boolValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key);
}

function normalizeProvider(value: unknown): string {
  const normalized = stringValue(
    value,
    DEFAULT_ASR_CONFIG.provider,
  ).toLowerCase();
  return ["cpu", "cuda", "coreml"].includes(normalized)
    ? normalized
    : DEFAULT_ASR_CONFIG.provider;
}

function normalizeMode(value: unknown, fallback: string): string {
  const normalized = stringValue(value, fallback).toLowerCase();
  return ["auto", "disabled", "force"].includes(normalized)
    ? normalized
    : fallback;
}

function getAsrDefaults(audio: Record<string, unknown>) {
  const saved = isRecord(audio[ASR_DEFAULTS_ID]) ? audio[ASR_DEFAULTS_ID] : {};
  const savedVad = isRecord(saved.vad) ? saved.vad : {};
  return {
    rate: numberValue(saved.rate, DEFAULT_ASR_CONFIG.rate),
    channel: numberValue(saved.channel, DEFAULT_ASR_CONFIG.channel),
    stream_simulate: boolValue(
      saved.stream_simulate,
      boolValue(audio.stream_simulate, DEFAULT_ASR_CONFIG.stream_simulate),
    ),
    hotword_llm_mode: normalizeMode(
      saved.hotword_llm_mode,
      DEFAULT_ASR_CONFIG.hotword_llm_mode,
    ),
    hotword_replace: boolValue(
      saved.hotword_replace,
      DEFAULT_ASR_CONFIG.hotword_replace,
    ),
    num_threads: numberValue(saved.num_threads, DEFAULT_ASR_CONFIG.num_threads),
    provider: normalizeProvider(saved.provider),
    punctuation_mode: normalizeMode(
      saved.punctuation_mode,
      DEFAULT_ASR_CONFIG.punctuation_mode,
    ),
    vad: {
      max_speech_duration: numberValue(
        savedVad.max_speech_duration,
        DEFAULT_ASR_CONFIG.vad.max_speech_duration,
      ),
      min_speech_duration: numberValue(
        savedVad.min_speech_duration,
        DEFAULT_ASR_CONFIG.vad.min_speech_duration,
      ),
      min_silence_duration: numberValue(
        savedVad.min_silence_duration,
        DEFAULT_ASR_CONFIG.vad.min_silence_duration,
      ),
      threshold: numberValue(
        savedVad.threshold,
        DEFAULT_ASR_CONFIG.vad.threshold,
      ),
    },
  };
}

function labelForParam(key: string): string {
  const labels: Record<string, string> = {
    rate: "音频采样",
    channel: "声道",
    stream_simulate: "模拟流式输出",
    hotword_llm_mode: "热词强化",
    hotword_replace: "热词替换",
    num_threads: "线程数",
    provider: "推理后端",
    punctuation_mode: "标点符号",
    max_speech_duration: "VAD 最大说话时长",
    min_speech_duration: "VAD 最小说话时长",
    min_silence_duration: "VAD 最小静音时长",
    threshold: "VAD 阈值",
  };
  return labels[key] || key.replace(/_/g, " ");
}

function ConfigRow({
  label,
  inherited,
  isOverride,
  onReset,
  children,
}: {
  label: string;
  inherited?: string;
  isOverride?: boolean;
  onReset?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 py-[5px]">
      <div className="min-w-[120px] shrink-0">
        <div className="text-xs text-text-dim">{label}</div>
        {inherited && (
          <div className="text-[10px] text-text-muted mt-0.5">{inherited}</div>
        )}
      </div>
      <div className="flex-1 min-w-0 flex items-center justify-end gap-2">
        {children}
        {isOverride && onReset && (
          <Button size="sm" variant="ghost" onClick={onReset}>
            继承
          </Button>
        )}
      </div>
    </div>
  );
}

function NumberConfigRow({
  label,
  value,
  onChange,
  step = 1,
  inherited,
  isOverride,
  onReset,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  step?: number;
  inherited?: string;
  isOverride?: boolean;
  onReset?: () => void;
}) {
  return (
    <ConfigRow
      label={label}
      inherited={inherited}
      isOverride={isOverride}
      onReset={onReset}
    >
      <input
        type="number"
        step={step}
        className="w-32 h-[34px] px-3 border border-border rounded-[6px] bg-input-bg text-text text-sm outline-none"
        value={value}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}
      />
    </ConfigRow>
  );
}

function ToggleConfigRow({
  label,
  value,
  onChange,
  inherited,
  isOverride,
  onReset,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
  inherited?: string;
  isOverride?: boolean;
  onReset?: () => void;
}) {
  return (
    <ConfigRow
      label={label}
      inherited={inherited}
      isOverride={isOverride}
      onReset={onReset}
    >
      <Toggle checked={value} onChange={onChange} />
    </ConfigRow>
  );
}

function SegmentConfigRow({
  label,
  value,
  options,
  onChange,
  inherited,
  isOverride,
  onReset,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  inherited?: string;
  isOverride?: boolean;
  onReset?: () => void;
}) {
  return (
    <ConfigRow
      label={label}
      inherited={inherited}
      isOverride={isOverride}
      onReset={onReset}
    >
      <SegmentedControl options={options} value={value} onChange={onChange} />
    </ConfigRow>
  );
}

function GenericConfigRows({
  values,
  overrides,
  onChange,
}: {
  values: Record<string, unknown>;
  overrides: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}) {
  return (
    <div className="space-y-1">
      {Object.entries(values).map(([key, value]) => {
        const isOverride = hasOwn(overrides, key);
        const reset = () => onChange(key, undefined);
        if (typeof value === "boolean") {
          return (
            <ToggleConfigRow
              key={key}
              label={labelForParam(key)}
              value={boolValue(overrides[key], value)}
              onChange={(next) => onChange(key, next)}
              isOverride={isOverride}
              onReset={reset}
            />
          );
        }
        if (typeof value === "number") {
          return (
            <NumberConfigRow
              key={key}
              label={labelForParam(key)}
              value={numberValue(overrides[key], value)}
              step={Number.isInteger(value) ? 1 : 0.1}
              onChange={(next) => onChange(key, next)}
              isOverride={isOverride}
              onReset={reset}
            />
          );
        }
        return (
          <ConfigRow
            key={key}
            label={labelForParam(key)}
            isOverride={isOverride}
            onReset={reset}
          >
            <input
              type="text"
              className="flex-1 min-w-0 h-[34px] px-3 border border-border rounded-[6px] bg-input-bg text-text text-sm outline-none"
              value={String(overrides[key] ?? value ?? "")}
              onChange={(e) => onChange(key, e.target.value)}
            />
          </ConfigRow>
        );
      })}
    </div>
  );
}

function CommonModelConfigRows({
  values,
  overrides,
  onChange,
}: {
  values: Record<string, unknown>;
  overrides: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}) {
  return (
    <div className="space-y-1">
      {Object.entries(values).map(([key, inheritedValue]) => {
        const isOverride = hasOwn(overrides, key);
        const effective = isOverride ? overrides[key] : inheritedValue;
        const inherited = `继承：${String(inheritedValue)}`;
        const reset = () => onChange(key, undefined);

        if (key === "provider") {
          return (
            <SegmentConfigRow
              key={key}
              label={labelForParam(key)}
              value={normalizeProvider(effective)}
              inherited={inherited.toUpperCase()}
              isOverride={isOverride}
              onReset={reset}
              options={[
                { value: "cpu", label: "CPU" },
                { value: "cuda", label: "CUDA" },
                { value: "coreml", label: "COREML" },
              ]}
              onChange={(value) => onChange(key, value)}
            />
          );
        }

        if (key === "hotword_llm_mode") {
          return (
            <SegmentConfigRow
              key={key}
              label={labelForParam(key)}
              value={normalizeMode(effective, "auto")}
              inherited={inherited}
              isOverride={isOverride}
              onReset={reset}
              options={[
                { value: "auto", label: "自动" },
                { value: "disabled", label: "关闭" },
                { value: "force", label: "开启" },
              ]}
              onChange={(value) => onChange(key, value)}
            />
          );
        }

        if (key === "punctuation_mode") {
          return (
            <SegmentConfigRow
              key={key}
              label={labelForParam(key)}
              value={normalizeMode(effective, "auto")}
              inherited={inherited}
              isOverride={isOverride}
              onReset={reset}
              options={[
                { value: "auto", label: "自适应" },
                { value: "disabled", label: "禁用" },
                { value: "force", label: "强制启用" },
              ]}
              onChange={(value) => onChange(key, value)}
            />
          );
        }

        if (typeof inheritedValue === "boolean") {
          return (
            <ToggleConfigRow
              key={key}
              label={labelForParam(key)}
              value={boolValue(effective, inheritedValue)}
              inherited={`继承：${inheritedValue ? "开启" : "关闭"}`}
              isOverride={isOverride}
              onReset={reset}
              onChange={(value) => onChange(key, value)}
            />
          );
        }

        return (
          <NumberConfigRow
            key={key}
            label={labelForParam(key)}
            value={numberValue(effective, numberValue(inheritedValue, 0))}
            step={Number.isInteger(inheritedValue) ? 1 : 0.1}
            inherited={inherited}
            isOverride={isOverride}
            onReset={reset}
            onChange={(value) => onChange(key, value)}
          />
        );
      })}
    </div>
  );
}

type DownloadProgressMap = Record<string, ModelDownloadProgress>;

const modelDownloadProgress: DownloadProgressMap = {};
const modelDownloadSubscribers = new Set<
  (progress: DownloadProgressMap) => void
>();
let modelDownloadProgressCleanup: (() => void) | null = null;

function getModelDownloadProgressSnapshot(): DownloadProgressMap {
  return { ...modelDownloadProgress };
}

function emitModelDownloadProgress(progress: ModelDownloadProgress) {
  modelDownloadProgress[progress.model_id] = progress;
  const snapshot = getModelDownloadProgressSnapshot();
  modelDownloadSubscribers.forEach((listener) => {
    listener(snapshot);
  });
}

function clearModelDownloadProgress(modelId: string) {
  delete modelDownloadProgress[modelId];
  const snapshot = getModelDownloadProgressSnapshot();
  modelDownloadSubscribers.forEach((listener) => {
    listener(snapshot);
  });
}

function subscribeModelDownloadProgress(
  listener: (progress: DownloadProgressMap) => void,
) {
  modelDownloadSubscribers.add(listener);
  listener(getModelDownloadProgressSnapshot());
  return () => {
    modelDownloadSubscribers.delete(listener);
  };
}

function ensureModelDownloadProgressListener() {
  if (modelDownloadProgressCleanup) return;
  modelDownloadProgressCleanup = onModelDownloadProgress(
    emitModelDownloadProgress,
  );
}

export function AudioModelPage() {
  const { settings, refresh } = useSettings();
  const cfg = settings?.parsedConfig || ({} as Record<string, unknown>);
  const audio = (cfg.audio || {}) as Record<string, unknown>;
  const provider = (audio.provider as string) || DOUBAO_MODEL_ID;
  const asrDefaults = getAsrDefaults(audio);

  const [tab, setTab] = useState<"online" | "offline">("online");
  const [customConfigOpen, setCustomConfigOpen] = useState(false);
  const [registry, setRegistry] = useState<RegistryModel[]>([]);
  const [downloaded, setDownloaded] = useState<string[]>([]);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgressMap>(
    getModelDownloadProgressSnapshot,
  );

  // Doubao config
  const doubaoCfg = (audio[DOUBAO_MODEL_ID] || {}) as Record<string, unknown>;

  const [doubaoExpanded, setDoubaoExpanded] = useState(false);
  const [configExpanded, setConfigExpanded] = useState<Set<string>>(new Set());

  const mounted = useRef(false);
  const doubaoValues = useRef<Record<string, unknown>>(clonePlain(doubaoCfg));

  useEffect(() => {
    mounted.current = true;
    ensureModelDownloadProgressListener();
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    doubaoValues.current = clonePlain(doubaoCfg || {});
  }, [doubaoCfg]);

  // Save helpers
  const saveDoubao = useCallback(
    async (updates: Record<string, unknown>) => {
      const merged = { ...clonePlain(doubaoCfg || {}), ...updates };
      doubaoValues.current = merged;
      await saveConfigObject({
        ...clonePlain(cfg),
        audio: { ...audio, [DOUBAO_MODEL_ID]: merged },
      });
      refresh();
    },
    [audio, cfg, doubaoCfg, refresh],
  );

  const saveAsrDefaults = useCallback(
    async (updates: Record<string, unknown>) => {
      const current = isRecord(audio[ASR_DEFAULTS_ID])
        ? clonePlain(audio[ASR_DEFAULTS_ID])
        : {};
      const next = { ...current, ...updates };
      if (updates.provider)
        next.provider = String(updates.provider).toLowerCase();
      await saveConfigObject({
        ...clonePlain(cfg),
        audio: { ...audio, [ASR_DEFAULTS_ID]: next },
      });
      refresh();
    },
    [audio, cfg, refresh],
  );

  const saveAsrVadDefaults = useCallback(
    async (updates: Record<string, unknown>) => {
      const current = isRecord(audio[ASR_DEFAULTS_ID])
        ? clonePlain(audio[ASR_DEFAULTS_ID])
        : {};
      const currentVad = isRecord(current.vad) ? current.vad : {};
      await saveAsrDefaults({ vad: { ...currentVad, ...updates } });
    },
    [audio, saveAsrDefaults],
  );

  const saveModelConfig = useCallback(
    async (modelId: string, updates: Record<string, unknown>) => {
      const current = isRecord(audio[modelId])
        ? clonePlain(audio[modelId])
        : {};
      const next = { ...current };
      for (const [key, value] of Object.entries(updates)) {
        if (value === undefined) delete next[key];
        else
          next[key] = key === "provider" ? String(value).toLowerCase() : value;
      }
      const nextAudio = { ...audio };
      if (Object.keys(next).length > 0) nextAudio[modelId] = next;
      else delete nextAudio[modelId];
      await saveConfigObject({ ...clonePlain(cfg), audio: nextAudio });
      refresh();
    },
    [audio, cfg, refresh],
  );

  const need = useCallback(async () => {
    try {
      const reg = ((await getModelRegistry()) ||
        []) as unknown as RegistryModel[];
      if (mounted.current) setRegistry(Array.isArray(reg) ? reg : []);
    } catch {
      /* ignore */
    }
    try {
      const ids = (await getDownloadedModels()) as string[];
      if (mounted.current) setDownloaded(Array.isArray(ids) ? ids : []);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    need();
  }, [need]);

  useEffect(() => subscribeModelDownloadProgress(setDownloadProgress), []);

  const updateModelDownloadProgress = useCallback(
    (progress: ModelDownloadProgress) => {
      emitModelDownloadProgress(progress);
      if (mounted.current)
        setDownloadProgress(getModelDownloadProgressSnapshot());
    },
    [],
  );

  // Model enable toggle
  const selectProvider = useCallback(
    async (id: string) => {
      const config = clonePlain(cfg);
      config.audio = config.audio || {};
      (config.audio as Record<string, unknown>).provider = id;
      await saveConfigObject(config);
      refresh();
    },
    [cfg, refresh],
  );

  // Download with VAD safety net
  const doDownload = useCallback(
    async (modelId: string) => {
      updateModelDownloadProgress({
        model_id: modelId,
        status: "downloading",
        progress: 0,
      });

      // VAD safety net
      if (modelId !== VAD_ID && !downloaded.includes(VAD_ID)) {
        try {
          await downloadModel(VAD_ID);
          if (mounted.current) {
            setDownloaded((prev) =>
              prev.includes(VAD_ID) ? prev : [...prev, VAD_ID],
            );
          }
        } catch {
          updateModelDownloadProgress({
            model_id: modelId,
            status: "failed",
            progress: modelDownloadProgress[modelId]?.progress,
          });
          return;
        }
      }
      try {
        await downloadModel(modelId);
        need();
      } catch {
        updateModelDownloadProgress({
          model_id: modelId,
          status: "failed",
          progress: modelDownloadProgress[modelId]?.progress,
        });
      }
    },
    [downloaded, need, updateModelDownloadProgress],
  );

  const doDelete = useCallback(
    async (id: string) => {
      await deleteModel(id);
      clearModelDownloadProgress(id);
      need();
    },
    [need],
  );

  const offlineModels = registry
    .filter((m) => m.type === "offline")
    .sort((a, b) => {
      if (a.category !== b.category) {
        if (a.category === "vad") return -1;
        if (b.category === "vad") return 1;
      }
      return 0;
    });

  const doubaoFromRegistry = registry.find((m) => m.id === DOUBAO_MODEL_ID);
  const currentProviderName =
    registry.find((m) => m.id === provider)?.name || provider;

  // Doubao toggle grid
  const doubaoToggles = [
    { key: "enable_ddc", label: "语义顺滑", defaultVal: true },
    { key: "enable_itn", label: "数字格式化", defaultVal: true },
    { key: "enable_nonstream", label: "二遍识别", defaultVal: false },
    { key: "enable_punc", label: "自动标点", defaultVal: true },
  ];

  const doubaoDefaultConfig = doubaoFromRegistry?.default_config || {};
  const doubaoAdvanced = Object.fromEntries(
    Object.entries({ ...doubaoDefaultConfig, ...doubaoCfg }).filter(
      ([key]) => !DOUBAO_VISIBLE_PARAMS.has(key) && !COMMON_MODEL_KEYS.has(key),
    ),
  );

  return (
    <PageLayout>
      <PageHeader
        title="音频模型"
        description={`当前：${currentProviderName}`}
      />

      <div className="flex items-center justify-between gap-3">
        <div className="inline-flex border border-border rounded-lg overflow-hidden">
          <button
            type="button"
            className={`px-4 py-[6px] text-sm font-medium transition-colors ${tab === "online" ? "bg-accent-soft text-accent" : "text-text-dim hover:bg-fill-hover"}`}
            onClick={() => setTab("online")}
          >
            在线模型
          </button>
          <button
            type="button"
            className={`px-4 py-[6px] text-sm font-medium transition-colors ${tab === "offline" ? "bg-accent-soft text-accent" : "text-text-dim hover:bg-fill-hover"}`}
            onClick={() => {
              setTab("offline");
              need();
            }}
          >
            本地模型
          </button>
        </div>
        <Button variant="ghost" onClick={() => setCustomConfigOpen(true)}>
          <Cog size={16} />
          自定义配置
        </Button>
      </div>

      <Modal
        open={customConfigOpen}
        onClose={() => setCustomConfigOpen(false)}
        title="自定义配置"
      >
        <div className="space-y-5">
          <div>
            <h3 className="text-sm font-semibold text-text mb-2">音频采样</h3>
            <NumberConfigRow
              label="音频采样"
              value={asrDefaults.rate}
              onChange={(value) => saveAsrDefaults({ rate: value })}
            />
            <NumberConfigRow
              label="声道"
              value={asrDefaults.channel}
              onChange={(value) => saveAsrDefaults({ channel: value })}
            />
          </div>

          <div className="border-t border-border-subtle pt-4">
            <h3 className="text-sm font-semibold text-text mb-2">识别强化</h3>
            <ToggleConfigRow
              label="模拟流式输出"
              value={asrDefaults.stream_simulate}
              onChange={(value) => saveAsrDefaults({ stream_simulate: value })}
            />
            <SegmentConfigRow
              label="热词强化"
              value={asrDefaults.hotword_llm_mode}
              options={[
                { value: "auto", label: "自动" },
                { value: "disabled", label: "关闭" },
                { value: "force", label: "开启" },
              ]}
              onChange={(value) => saveAsrDefaults({ hotword_llm_mode: value })}
            />
            <ToggleConfigRow
              label="热词替换"
              value={asrDefaults.hotword_replace}
              onChange={(value) => saveAsrDefaults({ hotword_replace: value })}
            />
          </div>

          <div className="border-t border-border-subtle pt-4">
            <h3 className="text-sm font-semibold text-text mb-2">离线模型</h3>
            <NumberConfigRow
              label="线程数"
              value={asrDefaults.num_threads}
              onChange={(value) => saveAsrDefaults({ num_threads: value })}
            />
            <SegmentConfigRow
              label="推理后端"
              value={asrDefaults.provider}
              options={[
                { value: "cpu", label: "CPU" },
                { value: "cuda", label: "CUDA" },
                { value: "coreml", label: "COREML" },
              ]}
              onChange={(value) => saveAsrDefaults({ provider: value })}
            />
            <SegmentConfigRow
              label="标点符号"
              value={asrDefaults.punctuation_mode}
              options={[
                { value: "auto", label: "自适应" },
                { value: "disabled", label: "禁用" },
                { value: "force", label: "强制启用" },
              ]}
              onChange={(value) => saveAsrDefaults({ punctuation_mode: value })}
            />
            <NumberConfigRow
              label="VAD 最大说话时长"
              value={asrDefaults.vad.max_speech_duration}
              step={0.1}
              onChange={(value) =>
                saveAsrVadDefaults({ max_speech_duration: value })
              }
            />
            <NumberConfigRow
              label="VAD 最小说话时长"
              value={asrDefaults.vad.min_speech_duration}
              step={0.1}
              onChange={(value) =>
                saveAsrVadDefaults({ min_speech_duration: value })
              }
            />
            <NumberConfigRow
              label="VAD 最小静音时长"
              value={asrDefaults.vad.min_silence_duration}
              step={0.1}
              onChange={(value) =>
                saveAsrVadDefaults({ min_silence_duration: value })
              }
            />
            <NumberConfigRow
              label="VAD 阈值"
              value={asrDefaults.vad.threshold}
              step={0.1}
              onChange={(value) => saveAsrVadDefaults({ threshold: value })}
            />
          </div>
        </div>
      </Modal>

      {tab === "online" && (
        <Section>
          <SectionHeader
            title={doubaoFromRegistry?.name || "火山引擎 - 豆包流式输出大模型"}
            subtitle="基于豆包大模型的流式语音识别服务"
            action={
              <div className="flex items-center gap-3">
                <a
                  className="text-xs text-accent hover:underline"
                  href="https://console.volcengine.com/speech/app"
                  target="_blank"
                  rel="noreferrer"
                >
                  如何获取 API 凭据？
                </a>
                <Toggle
                  checked={provider === DOUBAO_MODEL_ID}
                  onChange={async (v) => {
                    if (v) await selectProvider(DOUBAO_MODEL_ID);
                  }}
                />
              </div>
            }
          />
          <SectionContent>
            {/* Features */}
            <div className="flex flex-wrap items-center gap-3 text-xs mb-3">
              <span className="text-success">✓ 流式输出</span>
              <span className="text-success">✓ 热词库</span>
              <span className="text-success">✓ 自动标点</span>
              <span className="text-success">✓ 数字格式化</span>
              <span className="text-success">✓ zh, en</span>
              <span className="ml-auto">
                <button
                  type="button"
                  className="text-xs text-text-dim hover:text-text flex items-center gap-1"
                  onClick={() => setDoubaoExpanded(!doubaoExpanded)}
                >
                  <Cog size={16} />
                  参数配置
                </button>
              </span>
            </div>

            {/* Doubao config panel */}
            {doubaoExpanded && (
              <div className="border-t border-border-subtle pt-4 space-y-4">
                {/* Credentials */}
                <div className="space-y-3">
                  {[
                    {
                      label: "WebSocket 地址",
                      key: "url",
                      placeholder: "wss://...",
                      type: "text" as const,
                    },
                    {
                      label: "App ID",
                      key: "app_id",
                      placeholder: "输入 App ID",
                      type: "text" as const,
                    },
                    {
                      label: "Access Token",
                      key: "access_token",
                      placeholder: "输入 Access Token",
                      type: "password" as const,
                    },
                    {
                      label: "Secret Key",
                      key: "secret_key",
                      placeholder: "输入 Secret Key",
                      type: "password" as const,
                    },
                  ].map((f) => (
                    <div key={f.key} className="flex items-center gap-3">
                      <span className="text-xs text-text-dim w-[100px] shrink-0">
                        {f.label}
                      </span>
                      <input
                        type={f.type}
                        className="flex-1 h-[34px] px-3 rounded-lg bg-input-bg border border-border text-text text-sm focus:outline-none focus:ring-1 focus:ring-accent-dim"
                        value={(doubaoCfg[f.key] as string) || ""}
                        onChange={(e) =>
                          saveDoubao({ [f.key]: e.target.value })
                        }
                        placeholder={f.placeholder}
                      />
                    </div>
                  ))}
                </div>

                <div className="border-t border-border-subtle" />

                {/* Settings */}
                <div className="space-y-3">
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-text-dim w-[100px] shrink-0">
                      Resource ID
                    </span>
                    <input
                      type="text"
                      className="flex-1 h-[34px] px-3 rounded-lg bg-input-bg border border-border text-text text-sm focus:outline-none focus:ring-1 focus:ring-accent-dim"
                      value={(doubaoCfg.resource_id as string) || ""}
                      onChange={(e) =>
                        saveDoubao({ resource_id: e.target.value })
                      }
                      placeholder="输入 Resource ID"
                    />
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-text-dim w-[100px] shrink-0">
                      语言
                    </span>
                    <input
                      type="text"
                      className="flex-1 h-[34px] px-3 rounded-lg bg-input-bg border border-border text-text text-sm focus:outline-none focus:ring-1 focus:ring-accent-dim"
                      value={(doubaoCfg.language as string) || ""}
                      onChange={(e) => saveDoubao({ language: e.target.value })}
                      placeholder="留空则自动检测"
                    />
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-text-dim w-[100px] shrink-0">
                      热词表 ID
                    </span>
                    <input
                      type="text"
                      className="flex-1 h-[34px] px-3 rounded-lg bg-input-bg border border-border text-text text-sm focus:outline-none focus:ring-1 focus:ring-accent-dim"
                      value={
                        (doubaoCfg.corpus as Record<string, string>)
                          ?.boosting_table_id || ""
                      }
                      onChange={(e) =>
                        saveDoubao({
                          corpus: { boosting_table_id: e.target.value },
                        })
                      }
                      placeholder="输入热词表 ID"
                    />
                  </div>
                </div>

                <div className="border-t border-border-subtle" />

                {/* Toggle grid */}
                <div className="space-y-3">
                  {doubaoToggles.map((t) => (
                    <div
                      key={t.key}
                      className="flex items-center justify-between"
                    >
                      <span className="text-sm text-text">{t.label}</span>
                      <Toggle
                        checked={
                          doubaoCfg[t.key] !== undefined
                            ? !!doubaoCfg[t.key]
                            : t.defaultVal
                        }
                        onChange={(v) => saveDoubao({ [t.key]: v })}
                      />
                    </div>
                  ))}
                </div>

                <div className="border-t border-border-subtle" />
                <div className="space-y-1">
                  <NumberConfigRow
                    label="音频采样"
                    value={numberValue(doubaoCfg.rate, asrDefaults.rate)}
                    inherited={`继承：${asrDefaults.rate}`}
                    isOverride={hasOwn(doubaoCfg, "rate")}
                    onReset={() =>
                      saveModelConfig(DOUBAO_MODEL_ID, { rate: undefined })
                    }
                    onChange={(value) =>
                      saveModelConfig(DOUBAO_MODEL_ID, { rate: value })
                    }
                  />
                  <NumberConfigRow
                    label="声道"
                    value={numberValue(doubaoCfg.channel, asrDefaults.channel)}
                    inherited={`继承：${asrDefaults.channel}`}
                    isOverride={hasOwn(doubaoCfg, "channel")}
                    onReset={() =>
                      saveModelConfig(DOUBAO_MODEL_ID, { channel: undefined })
                    }
                    onChange={(value) =>
                      saveModelConfig(DOUBAO_MODEL_ID, { channel: value })
                    }
                  />
                  <SegmentConfigRow
                    label="热词强化"
                    value={normalizeMode(
                      doubaoCfg.hotword_llm_mode,
                      asrDefaults.hotword_llm_mode,
                    )}
                    inherited={`继承：${asrDefaults.hotword_llm_mode}`}
                    isOverride={hasOwn(doubaoCfg, "hotword_llm_mode")}
                    onReset={() =>
                      saveModelConfig(DOUBAO_MODEL_ID, {
                        hotword_llm_mode: undefined,
                      })
                    }
                    options={[
                      { value: "auto", label: "自动" },
                      { value: "disabled", label: "关闭" },
                      { value: "force", label: "开启" },
                    ]}
                    onChange={(value) =>
                      saveModelConfig(DOUBAO_MODEL_ID, {
                        hotword_llm_mode: value,
                      })
                    }
                  />
                  <ToggleConfigRow
                    label="热词替换"
                    value={boolValue(
                      doubaoCfg.hotword_replace,
                      asrDefaults.hotword_replace,
                    )}
                    inherited={`继承：${asrDefaults.hotword_replace ? "开启" : "关闭"}`}
                    isOverride={hasOwn(doubaoCfg, "hotword_replace")}
                    onReset={() =>
                      saveModelConfig(DOUBAO_MODEL_ID, {
                        hotword_replace: undefined,
                      })
                    }
                    onChange={(value) =>
                      saveModelConfig(DOUBAO_MODEL_ID, {
                        hotword_replace: value,
                      })
                    }
                  />
                </div>

                {/* Advanced params */}
                {Object.keys(doubaoAdvanced).length > 0 && (
                  <>
                    <div className="border-t border-border-subtle" />
                    <GenericConfigRows
                      values={doubaoAdvanced}
                      overrides={doubaoCfg}
                      onChange={(key, value) =>
                        saveModelConfig(DOUBAO_MODEL_ID, { [key]: value })
                      }
                    />
                  </>
                )}
              </div>
            )}
          </SectionContent>
        </Section>
      )}

      {tab === "offline" && (
        <>
          {offlineModels.length === 0 && (
            <p className="text-sm text-text-muted">暂无可用本地模型</p>
          )}
          {offlineModels.map((model) => {
            const progressState = downloadProgress[model.id];
            const isDownloaded =
              downloaded.includes(model.id) ||
              progressState?.status === "completed";
            const isActive = provider === model.id;
            const isBaseModel =
              model.category === "vad" || model.category === "punctuation";
            const isDownloading = progressState?.status === "downloading";
            const isDownloadFailed = progressState?.status === "failed";
            const progress =
              typeof progressState?.progress === "number"
                ? Math.max(0, Math.min(100, Math.round(progressState.progress)))
                : undefined;
            const memStr = model.mem_size ? `${model.mem_size}MB` : "";
            const audioCfg = (cfg.audio as Record<string, unknown>) || {};
            const modelOverrides = isRecord(audioCfg[model.id])
              ? (audioCfg[model.id] as Record<string, unknown>)
              : {};
            const commonConfig: Record<string, unknown> =
              model.category === "vad"
                ? {
                    num_threads: asrDefaults.num_threads,
                    provider: asrDefaults.provider,
                    threshold: asrDefaults.vad.threshold,
                    min_silence_duration: asrDefaults.vad.min_silence_duration,
                    min_speech_duration: asrDefaults.vad.min_speech_duration,
                    max_speech_duration: asrDefaults.vad.max_speech_duration,
                  }
                : model.category === "punctuation"
                  ? {
                      num_threads: asrDefaults.num_threads,
                      provider: asrDefaults.provider,
                    }
                  : {
                      stream_simulate: asrDefaults.stream_simulate,
                      hotword_llm_mode: asrDefaults.hotword_llm_mode,
                      hotword_replace: asrDefaults.hotword_replace,
                      num_threads: asrDefaults.num_threads,
                      provider: asrDefaults.provider,
                      punctuation_mode: asrDefaults.punctuation_mode,
                    };
            const modelCfg: Record<string, unknown> = {
              ...(model.default_config || {}),
              ...commonConfig,
              ...modelOverrides,
            };
            const advancedCfg = Object.fromEntries(
              Object.entries(modelCfg).filter(
                ([key]) => !COMMON_MODEL_KEYS.has(key),
              ),
            );
            const hasConfig = Object.keys(modelCfg).length > 0;

            return (
              <Section key={model.id}>
                <SectionHeader
                  title={model.name}
                  subtitle={`${model.description}${memStr ? ` · 预计内存占用峰值：${memStr}` : ""}`}
                  action={
                    <div className="flex items-center gap-2 justify-end">
                      {isDownloading && (
                        <div className="h-1.5 w-24 rounded-full bg-fill-track overflow-hidden">
                          <div
                            className="h-full rounded-full bg-accent transition-[width]"
                            style={{ width: `${progress ?? 0}%` }}
                          />
                        </div>
                      )}
                      {isDownloaded ? (
                        <>
                          {!isBaseModel && (
                            <Toggle
                              checked={isActive}
                              onChange={async (v) => {
                                if (v) await selectProvider(model.id);
                              }}
                            />
                          )}
                          <Button size="sm" onClick={() => doDelete(model.id)}>
                            <Trash size={16} />
                          </Button>
                        </>
                      ) : (
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-text-muted shrink-0">
                            模型文件 {model.file_size}MB
                          </span>

                          <Button
                            size="sm"
                            onClick={() => doDownload(model.id)}
                            disabled={isDownloading}
                          >
                            {isDownloading ? (
                              <LoaderCircle
                                size={16}
                                className="animate-spin"
                              />
                            ) : isDownloadFailed ? (
                              <RotateCcw size={16} />
                            ) : (
                              <CloudDownload size={16} />
                            )}
                          </Button>
                        </div>
                      )}
                    </div>
                  }
                />
                <SectionContent>
                  {/* Features */}
                  {model.capabilities && (
                    <div className="flex justify-between gap-3 text-sm ">
                      {Object.entries({
                        streaming: "流式输出",
                        hotwords: "热词库",
                        punctuation: "自动标点",
                        itn: "数字格式化",
                      }).map(([k, label]) => (
                        <div key={k} className="flex gap-1 items-center">
                          {model.capabilities?.[k] ? (
                            <CircleCheck
                              size={16}
                              className="fill-success text-white"
                            />
                          ) : (
                            <CircleX size={16} />
                          )}
                          <span
                            className={
                              model.capabilities?.[k]
                                ? "text-success"
                                : "text-text-muted"
                            }
                          >
                            {label}
                          </span>
                        </div>
                      ))}
                      {hasConfig && (
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setConfigExpanded((prev) => {
                              const next = new Set(prev);
                              if (next.has(model.id)) next.delete(model.id);
                              else next.add(model.id);
                              return next;
                            });
                          }}
                        >
                          <Cog size={16} />
                          参数配置
                        </Button>
                      )}
                    </div>
                  )}

                  {/* Expandable config */}
                  {configExpanded.has(model.id) && hasConfig && (
                    <div className="border-t border-border-subtle pt-3 space-y-3">
                      <CommonModelConfigRows
                        values={commonConfig}
                        overrides={modelOverrides}
                        onChange={(key, value) =>
                          saveModelConfig(model.id, { [key]: value })
                        }
                      />
                      {Object.keys(advancedCfg).length > 0 && (
                        <>
                          <div className="border-t border-border-subtle" />
                          <GenericConfigRows
                            values={advancedCfg}
                            overrides={modelOverrides}
                            onChange={(key, value) =>
                              saveModelConfig(model.id, { [key]: value })
                            }
                          />
                        </>
                      )}
                    </div>
                  )}
                </SectionContent>
              </Section>
            );
          })}
        </>
      )}
    </PageLayout>
  );
}
