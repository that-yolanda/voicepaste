import {
  CircleCheck,
  CloudDownload,
  Cog,
  LoaderCircle,
  RotateCcw,
  Trash,
  ChartNoAxesCombined,
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
  getAudioConfigDefaults,
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
import { Badge } from "@/ui/components/Badge";
import { Button } from "@/ui/components/Button";
import { Input } from "@/ui/components/Input";
import { Modal } from "@/ui/components/Modal";
import { SegmentedControl } from "@/ui/components/SegmentedControl";
import { Textarea } from "@/ui/components/Textarea";
import { Toggle } from "@/ui/components/Toggle";
import {
  PageHeader,
  PageLayout,
  Section,
  SectionContent,
  SectionHeader,
  SectionItem,
  SectionItemList,
} from "@/ui/layout/PageLayout";
import { useSettings } from "@/ui/SettingsProvider";

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

function getAsrDefaults(
  audio: Record<string, unknown>,
  defaults = DEFAULT_ASR_CONFIG,
) {
  const saved = isRecord(audio[ASR_DEFAULTS_ID]) ? audio[ASR_DEFAULTS_ID] : {};
  const savedVad = isRecord(saved.vad) ? saved.vad : {};
  return {
    rate: numberValue(saved.rate, defaults.rate),
    channel: numberValue(saved.channel, defaults.channel),
    stream_simulate: boolValue(
      saved.stream_simulate,
      boolValue(audio.stream_simulate, defaults.stream_simulate),
    ),
    hotword_llm_mode: normalizeMode(
      saved.hotword_llm_mode,
      defaults.hotword_llm_mode,
    ),
    hotword_replace: boolValue(saved.hotword_replace, defaults.hotword_replace),
    num_threads: numberValue(saved.num_threads, defaults.num_threads),
    provider: normalizeProvider(saved.provider),
    punctuation_mode: normalizeMode(
      saved.punctuation_mode,
      defaults.punctuation_mode,
    ),
    vad: {
      max_speech_duration: numberValue(
        savedVad.max_speech_duration,
        defaults.vad.max_speech_duration,
      ),
      min_speech_duration: numberValue(
        savedVad.min_speech_duration,
        defaults.vad.min_speech_duration,
      ),
      min_silence_duration: numberValue(
        savedVad.min_silence_duration,
        defaults.vad.min_silence_duration,
      ),
      threshold: numberValue(savedVad.threshold, defaults.vad.threshold),
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
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return <SectionItem title={label} action={children} />;
}

function NumberConfigRow({
  label,
  value,
  onChange,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  step?: number;
}) {
  return (
    <ConfigRow label={label}>
      <Input
        type="number"
        step={step}
        className="w-36"
        value={value}
        onChange={(nextValue) => {
          const next = Number(nextValue);
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
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <ConfigRow label={label}>
      <Toggle checked={value} onChange={onChange} />
    </ConfigRow>
  );
}

function SegmentConfigRow({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <ConfigRow label={label}>
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
    <SectionItemList>
      {Object.entries(values).map(([key, value]) => {
        if (typeof value === "boolean") {
          return (
            <ToggleConfigRow
              key={key}
              label={labelForParam(key)}
              value={boolValue(overrides[key], value)}
              onChange={(next) => onChange(key, next)}
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
            />
          );
        }
        if (key.includes("prompt")) {
          return (
            <SectionItem key={key} title={labelForParam(key)}>
              <Textarea
                value={String(overrides[key] ?? value ?? "")}
                onChange={(next) => onChange(key, next)}
                textareaClassName="min-h-20"
              />
            </SectionItem>
          );
        }
        return (
          <ConfigRow key={key} label={labelForParam(key)}>
            <Input
              type="text"
              className="w-56"
              value={String(overrides[key] ?? value ?? "")}
              onChange={(next) => onChange(key, next)}
            />
          </ConfigRow>
        );
      })}
    </SectionItemList>
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
  const [runtimeDefaults, setRuntimeDefaults] = useState(DEFAULT_ASR_CONFIG);
  const asrDefaults = getAsrDefaults(audio, runtimeDefaults);

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

  useEffect(() => {
    mounted.current = true;
    ensureModelDownloadProgressListener();
    getAudioConfigDefaults()
      .then((defaults) => {
        if (mounted.current && isRecord(defaults)) {
          setRuntimeDefaults(getAsrDefaults({ [ASR_DEFAULTS_ID]: defaults }));
        }
      })
      .catch(() => {});
    return () => {
      mounted.current = false;
    };
  }, []);

  // Save helpers
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

  const resetModelConfig = useCallback(
    async (modelId: string) => {
      const nextAudio = { ...audio };
      delete nextAudio[modelId];
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

  // Backend downloads required sherpa-onnx base models before ASR models.
  const doDownload = useCallback(
    async (modelId: string) => {
      updateModelDownloadProgress({
        model_id: modelId,
        status: "downloading",
        progress: 0,
      });
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
    [need, updateModelDownloadProgress],
  );

  const doDelete = useCallback(
    async (id: string) => {
      await deleteModel(id);
      clearModelDownloadProgress(id);
      need();
    },
    [need],
  );

  const offlineModels = registry.filter(
    (m) => m.type === "offline" && m.category === "asr",
  );
  const baseModels = registry.filter(
    (m) =>
      m.type === "offline" &&
      (m.category === "vad" || m.category === "punctuation"),
  );

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
        <SegmentedControl
          options={[
            { value: "online", label: "在线模型" },
            { value: "offline", label: "本地模型" },
          ]}
          value={tab}
          onChange={(value) => {
            const next = value === "offline" ? "offline" : "online";
            setTab(next);
            if (next === "offline") need();
          }}
        />
        <Button variant="ghost" onClick={() => setCustomConfigOpen(true)}>
          <Cog size={16} />
          自定义配置
        </Button>
      </div>

      <CustomConfigModal
        open={customConfigOpen}
        onClose={() => setCustomConfigOpen(false)}
        asrDefaults={asrDefaults}
        saveAsrDefaults={saveAsrDefaults}
        saveAsrVadDefaults={saveAsrVadDefaults}
      />

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
            <div className="flex flex-wrap items-center gap-2 mb-3">
              {doubaoFromRegistry?.tags?.map((tag) => (
                <Badge key={tag} variant="accent">
                  {tag}
                </Badge>
              ))}
              {doubaoFromRegistry?.capabilities &&
                Object.entries({
                  streaming: "流式输出",
                  hotwords: "热词库",
                  punctuation: "自动标点",
                  itn: "数字格式化",
                }).map(([key, label]) => (
                  <Badge
                    key={key}
                    variant={
                      doubaoFromRegistry.capabilities?.[key]
                        ? "success"
                        : "muted"
                    }
                  >
                    <CircleCheck size={14} />
                    {label}
                  </Badge>
                ))}
              <span className="ml-auto">
                <Button
                  variant="ghost"
                  onClick={() => setDoubaoExpanded(!doubaoExpanded)}
                >
                  <Cog size={16} />
                  参数配置
                </Button>
              </span>
            </div>

            {/* Doubao config panel */}
            {doubaoExpanded && (
              <div className="border-t border-border-subtle pt-4 space-y-4">
                {/* Credentials */}
                <SectionItemList>
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
                    <SectionItem
                      key={f.key}
                      title={f.label}
                      action={
                        <Input
                          type={f.type}
                          className="w-full"
                          value={(doubaoCfg[f.key] as string) || ""}
                          onChange={(value) =>
                            saveModelConfig(DOUBAO_MODEL_ID, { [f.key]: value })
                          }
                          placeholder={f.placeholder}
                        />
                      }
                    />
                  ))}
                </SectionItemList>

                {/* Settings */}
                <SectionItemList>
                  <SectionItem
                    title="Resource ID"
                    action={
                      <Input
                        className="w-full"
                        value={(doubaoCfg.resource_id as string) || ""}
                        onChange={(value) =>
                          saveModelConfig(DOUBAO_MODEL_ID, {
                            resource_id: value,
                          })
                        }
                        placeholder="输入 Resource ID"
                      />
                    }
                  />
                  <SectionItem
                    title="语言"
                    action={
                      <Input
                        className="w-full"
                        value={(doubaoCfg.language as string) || ""}
                        onChange={(value) =>
                          saveModelConfig(DOUBAO_MODEL_ID, { language: value })
                        }
                        placeholder="留空则自动检测"
                      />
                    }
                  />
                  <SectionItem
                    title="热词表 ID"
                    last
                    action={
                      <Input
                        className="w-full"
                        value={
                          (doubaoCfg.corpus as Record<string, string>)
                            ?.boosting_table_id || ""
                        }
                        onChange={(value) =>
                          saveModelConfig(DOUBAO_MODEL_ID, {
                            corpus: { boosting_table_id: value },
                          })
                        }
                        placeholder="输入热词表 ID"
                      />
                    }
                  />
                </SectionItemList>

                {/* Toggle grid */}
                <SectionItemList>
                  {doubaoToggles.map((t) => (
                    <SectionItem
                      key={t.key}
                      title={t.label}
                      action={
                        <Toggle
                          checked={
                            doubaoCfg[t.key] !== undefined
                              ? !!doubaoCfg[t.key]
                              : t.defaultVal
                          }
                          onChange={(v) =>
                            saveModelConfig(DOUBAO_MODEL_ID, { [t.key]: v })
                          }
                        />
                      }
                    ></SectionItem>
                  ))}
                </SectionItemList>

                <div className="border-t border-border-subtle" />
                <div className="space-y-1">
                  <NumberConfigRow
                    label="音频采样"
                    value={numberValue(doubaoCfg.rate, asrDefaults.rate)}
                    onChange={(value) =>
                      saveModelConfig(DOUBAO_MODEL_ID, { rate: value })
                    }
                  />
                  <NumberConfigRow
                    label="声道"
                    value={numberValue(doubaoCfg.channel, asrDefaults.channel)}
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
                <div className="pt-1">
                  <Button onClick={() => resetModelConfig(DOUBAO_MODEL_ID)}>
                    <RotateCcw size={16} />
                    恢复默认
                  </Button>
                </div>
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
            const fileStr = model.file_size ? `${model.file_size}MB` : "";
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
            const hasConfig = !isBaseModel && Object.keys(modelCfg).length > 0;

            return (
              <Section key={model.id}>
                <SectionHeader
                  title={model.name}
                  subtitle={model.description}
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
                          <Button
                            size="icon"
                            onClick={() => doDelete(model.id)}
                          >
                            <Trash size={16} />
                          </Button>

                          {!isBaseModel && (
                            <Toggle
                              checked={isActive}
                              onChange={async (v) => {
                                if (v) await selectProvider(model.id);
                              }}
                            />
                          )}
                        </>
                      ) : (
                        <div className="flex items-center gap-2">
                          {fileStr && (
                            <span className="text-xs text-text-muted">
                              模型文件 {fileStr}
                            </span>
                          )}
                          <Button
                            size="icon"
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
                  <div className="flex flex-wrap items-center gap-2 mb-3">
                    {model.tags?.map((tag) => (
                      <Badge key={tag} variant="accent">
                        {tag}
                      </Badge>
                    ))}

                    {memStr && (
                      <div className="flex gap-1 text-text-muted">
                        <ChartNoAxesCombined size={16} />
                        <span className="text-xs ">内存峰值 {memStr}</span>
                      </div>
                    )}
                  </div>
                  {/* Features */}
                  {model.capabilities && (
                    <div className="flex items-center gap-2 flex-wrap text-sm">
                      {Object.entries({
                        streaming: "流式输出",
                        hotwords: "热词库",
                        punctuation: "自动标点",
                        itn: "数字格式化",
                      }).map(([k, label]) => (
                        <Badge
                          key={k}
                          variant={
                            model.capabilities?.[k] ? "success" : "muted"
                          }
                        >
                          <CircleCheck size={14} />
                          <span>{label}</span>
                        </Badge>
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
                      <div className="pt-1">
                        <Button onClick={() => resetModelConfig(model.id)}>
                          <RotateCcw size={16} />
                          恢复默认
                        </Button>
                      </div>
                    </div>
                  )}
                </SectionContent>
              </Section>
            );
          })}
          {baseModels.length > 0 && (
            <div className="pt-2">
              <h2 className="text-sm font-semibold text-text mb-3">基础模型</h2>
              <div className="space-y-5">
                {baseModels.map((model) => {
                  const progressState = downloadProgress[model.id];
                  const isDownloaded =
                    downloaded.includes(model.id) ||
                    progressState?.status === "completed";
                  const isDownloading = progressState?.status === "downloading";
                  const isDownloadFailed = progressState?.status === "failed";
                  const progress =
                    typeof progressState?.progress === "number"
                      ? Math.max(
                          0,
                          Math.min(100, Math.round(progressState.progress)),
                        )
                      : undefined;

                  const fileStr = model.file_size ? `${model.file_size}MB` : "";

                  return (
                    <Section key={model.id}>
                      <SectionHeader
                        title={model.name}
                        subtitle={model.description}
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
                              <Button
                                size="icon"
                                onClick={() => doDelete(model.id)}
                              >
                                <Trash size={16} />
                              </Button>
                            ) : (
                              <div className="flex items-center gap-2">
                                {fileStr && (
                                  <span className="text-xs text-text-muted">
                                    模型文件 {fileStr}
                                  </span>
                                )}
                                <Button
                                  size="icon"
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
                        <div className="flex flex-wrap items-center gap-2">
                          {model.tags?.map((tag) => (
                            <Badge key={tag} variant="accent">
                              {tag}
                            </Badge>
                          ))}
                        </div>
                      </SectionContent>
                    </Section>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </PageLayout>
  );
}

const CustomConfigModal = ({
  open,
  onClose,
  asrDefaults,
  saveAsrDefaults,
  saveAsrVadDefaults,
}: {
  open: boolean;
  onClose: () => void;
  asrDefaults: ReturnType<typeof getAsrDefaults>;
  saveAsrDefaults: (updates: Record<string, unknown>) => Promise<void>;
  saveAsrVadDefaults: (updates: Record<string, unknown>) => Promise<void>;
}) => {
  return (
    <Modal open={open} onClose={onClose} title="自定义配置">
      <div className="space-y-5">
        <Section>
          <SectionHeader title="音频采样" />
          <SectionContent>
            <SectionItemList>
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
            </SectionItemList>
          </SectionContent>
        </Section>

        <Section>
          <SectionHeader title="识别强化" />
          <SectionContent>
            <SectionItemList>
              <ToggleConfigRow
                label="模拟流式输出"
                value={asrDefaults.stream_simulate}
                onChange={(value) =>
                  saveAsrDefaults({ stream_simulate: value })
                }
              />
              <SegmentConfigRow
                label="热词强化"
                value={asrDefaults.hotword_llm_mode}
                options={[
                  { value: "auto", label: "自动" },
                  { value: "disabled", label: "关闭" },
                  { value: "force", label: "开启" },
                ]}
                onChange={(value) =>
                  saveAsrDefaults({ hotword_llm_mode: value })
                }
              />
              <ToggleConfigRow
                label="热词替换"
                value={asrDefaults.hotword_replace}
                onChange={(value) =>
                  saveAsrDefaults({ hotword_replace: value })
                }
              />
            </SectionItemList>
          </SectionContent>
        </Section>

        <Section>
          <SectionHeader title="离线模型" />
          <SectionContent>
            <SectionItemList>
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
                onChange={(value) =>
                  saveAsrDefaults({ punctuation_mode: value })
                }
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
            </SectionItemList>
          </SectionContent>
        </Section>
      </div>
    </Modal>
  );
};
