import { CircleCheck, Cog } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  deleteModel,
  downloadModel,
  getAudioConfigDefaults,
  getDownloadedModels,
  getModelRegistry,
  type ModelDownloadProgress,
  onModelDownloadProgress,
  saveConfigObject,
} from "@/settings/bridge";
import { Badge } from "@/settings/components/Badge";
import { Button } from "@/settings/components/Button";
import { Modal } from "@/settings/components/Modal";
import { ModelCard, type ModelCardProps, renderControl } from "@/settings/components/ModelCard";
import { SegmentedControl } from "@/settings/components/SegmentedControl";
import {
  PageHeader,
  PageLayout,
  Section,
  SectionContent,
  SectionHeader,
  SectionItem,
  SectionItemList,
} from "@/settings/layout/PageLayout";
import { clonePlain } from "@/settings/lib/clone";
import {
  type AsrDefaults,
  DOUBAO_MODEL_ID,
  getFieldMeta,
  mergeAsrDefaults,
} from "@/settings/lib/model";
import { useSettings } from "@/settings/SettingsProvider";
import type { RegistryModel } from "@/settings/types/models";

const ASR_DEFAULTS_ID = "asr_defaults";

type DownloadProgressMap = Record<string, ModelDownloadProgress>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** asr_defaults fields shown in the CustomConfigModal, grouped by section. */
const ASR_DEFAULT_SECTIONS: { title: string; fields: string[] }[] = [
  { title: "音频采样", fields: ["rate", "channel"] },
  {
    title: "识别强化",
    fields: ["stream_simulate", "hotword_llm_mode", "hotword_replace"],
  },
  {
    title: "离线模型推理",
    fields: [
      "num_threads",
      "provider",
      "punctuation_mode",
      "vad.max_speech_duration",
      "vad.min_speech_duration",
      "vad.min_silence_duration",
      "vad.threshold",
    ],
  },
];

export function AudioModelPage() {
  const { settings, refresh } = useSettings();
  const cfg = (settings?.parsedConfig || {}) as Record<string, unknown>;
  const audio = (cfg.audio || {}) as Record<string, unknown>;
  const provider = (audio.provider as string) || DOUBAO_MODEL_ID;

  const [tab, setTab] = useState<"online" | "offline">("online");
  const [customConfigOpen, setCustomConfigOpen] = useState(false);
  const [registry, setRegistry] = useState<RegistryModel[]>([]);
  const [downloaded, setDownloaded] = useState<string[]>([]);
  const [runtimeDefaults, setRuntimeDefaults] = useState<AsrDefaults | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgressMap>({});

  const mounted = useRef(false);

  // runtimeDefaults = backend defaults (AsrDefaults::default()). The displayed
  // asr_defaults merges these with the user-saved audio.asr_defaults overrides,
  // so edits saved to config.yaml reflect back in the CustomConfigModal.
  useEffect(() => {
    mounted.current = true;
    getAudioConfigDefaults()
      .then((defaults) => {
        if (mounted.current && isRecord(defaults)) {
          setRuntimeDefaults(defaults as unknown as AsrDefaults);
        }
      })
      .catch(() => {});
    return () => {
      mounted.current = false;
    };
  }, []);

  const asrDefaults = useMemo(
    () => (runtimeDefaults ? mergeAsrDefaults(runtimeDefaults, audio[ASR_DEFAULTS_ID]) : null),
    [runtimeDefaults, audio],
  );

  const refreshDownloaded = useCallback(async () => {
    try {
      const ids = (await getDownloadedModels()) as string[];
      if (mounted.current) setDownloaded(Array.isArray(ids) ? ids : []);
    } catch {
      /* ignore */
    }
  }, []);

  const refreshRegistry = useCallback(async () => {
    try {
      const reg = ((await getModelRegistry()) || []) as unknown as RegistryModel[];
      if (mounted.current) setRegistry(Array.isArray(reg) ? reg : []);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    refreshRegistry();
    refreshDownloaded();
  }, [refreshRegistry, refreshDownloaded]);

  // Download progress: subscribe only while mounted. Re-entering the page
  // re-queries `getDownloadedModels` to recover accurate downloaded/not-downloaded
  // state; in-flight progress is transient and intentionally not persisted.
  useEffect(
    () =>
      onModelDownloadProgress((p) => {
        setDownloadProgress((prev) => ({ ...prev, [p.model_id]: p }));
        if (p.status === "completed") refreshDownloaded();
      }),
    [refreshDownloaded],
  );

  /* ---------- Save helpers ---------- */

  const saveAsrDefaults = useCallback(
    async (updates: Record<string, unknown>) => {
      const current = isRecord(audio[ASR_DEFAULTS_ID]) ? clonePlain(audio[ASR_DEFAULTS_ID]) : {};
      const next = { ...current, ...updates };
      if (updates.provider) next.provider = String(updates.provider).toLowerCase();
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
      const current = isRecord(audio[ASR_DEFAULTS_ID]) ? clonePlain(audio[ASR_DEFAULTS_ID]) : {};
      const currentVad = isRecord(current.vad) ? current.vad : {};
      await saveAsrDefaults({ vad: { ...currentVad, ...updates } });
    },
    [audio, saveAsrDefaults],
  );

  const saveModelConfig = useCallback(
    async (modelId: string, updates: Record<string, unknown>) => {
      const current = isRecord(audio[modelId]) ? clonePlain(audio[modelId]) : {};
      const next = { ...current };
      for (const [key, value] of Object.entries(updates)) {
        if (value === undefined) delete next[key];
        else next[key] = key === "provider" ? String(value).toLowerCase() : value;
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

  const doDownload = useCallback(
    async (modelId: string) => {
      setDownloadProgress((prev) => ({
        ...prev,
        [modelId]: { model_id: modelId, status: "downloading", progress: 0 },
      }));
      try {
        await downloadModel(modelId);
        await refreshDownloaded();
      } catch {
        setDownloadProgress((prev) => ({
          ...prev,
          [modelId]: { model_id: modelId, status: "failed" },
        }));
      }
    },
    [refreshDownloaded],
  );

  const doDelete = useCallback(
    async (id: string) => {
      await deleteModel(id);
      setDownloadProgress((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      refreshDownloaded();
    },
    [refreshDownloaded],
  );

  /* ---------- Derived ---------- */

  const currentName = registry.find((m) => m.id === provider)?.name || provider;
  const isModelDownloaded = (m: RegistryModel) =>
    m.type === "online" ||
    downloaded.includes(m.id) ||
    downloadProgress[m.id]?.status === "completed";

  const onlineModels = registry.filter((m) => m.type === "online" && m.category === "asr");
  const offlineAsrModels = registry.filter((m) => m.type === "offline" && m.category === "asr");
  const baseModels = registry.filter(
    (m) => m.type === "offline" && (m.category === "vad" || m.category === "punctuation"),
  );

  const cardProps = (m: RegistryModel): Omit<ModelCardProps, "model"> => ({
    isActive: provider === m.id,
    isDownloaded: isModelDownloaded(m),
    userConfig: audio[m.id] as Record<string, unknown> | undefined,
    asrDefaults,
    downloadProgress: downloadProgress[m.id],
    onToggleActive: (id) => selectProvider(id),
    onDownload: doDownload,
    onDelete: doDelete,
    onConfigChange: saveModelConfig,
    onResetConfig: resetModelConfig,
  });

  return (
    <PageLayout>
      <PageHeader title="音频模型" description={`当前：${currentName}`}>
        <div className="flex items-center gap-4 mt-2 text-text-muted">
          <span className="flex items-center gap-1">
            <Badge variant="ghost">
              <CircleCheck size={16} className="fill-success text-surface" />
            </Badge>
            原生支持
          </span>
          <span className="flex items-center gap-1">
            <Badge variant="ghost">
              <CircleCheck size={16} className="fill-text-muted text-surface" />
            </Badge>
            其他方式支持
          </span>
        </div>
      </PageHeader>

      <div className="flex items-center justify-between gap-3">
        <SegmentedControl
          options={[
            { value: "online", label: "在线模型" },
            { value: "offline", label: "本地模型" },
          ]}
          value={tab}
          onChange={(value) => setTab(value === "offline" ? "offline" : "online")}
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

      {tab === "online" &&
        onlineModels.map((m) => <ModelCard key={m.id} model={m} {...cardProps(m)} />)}

      {tab === "offline" && (
        <>
          {offlineAsrModels.length === 0 && (
            <p className="text-sm text-text-muted">暂无可用本地模型</p>
          )}
          {offlineAsrModels.map((m) => (
            <ModelCard key={m.id} model={m} {...cardProps(m)} />
          ))}
          {baseModels.length > 0 && (
            <div className="pt-2">
              <h2 className="text-sm font-semibold text-text mb-3">基础模型</h2>
              <div className="space-y-5">
                {baseModels.map((m) => (
                  <ModelCard key={m.id} model={m} {...cardProps(m)} />
                ))}
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
  asrDefaults: AsrDefaults | null;
  saveAsrDefaults: (updates: Record<string, unknown>) => Promise<void>;
  saveAsrVadDefaults: (updates: Record<string, unknown>) => Promise<void>;
}) => {
  const getValue = (flatKey: string): unknown => {
    if (!asrDefaults) return undefined;
    if (flatKey.startsWith("vad.")) {
      const vad = asrDefaults.vad as Record<string, unknown> | undefined;
      return vad?.[flatKey.slice(4)];
    }
    return (asrDefaults as unknown as Record<string, unknown>)[flatKey];
  };

  const handleChange = (flatKey: string, value: unknown) => {
    if (flatKey.startsWith("vad.")) {
      saveAsrVadDefaults({ [flatKey.slice(4)]: value });
    } else {
      saveAsrDefaults({ [flatKey]: value });
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="自定义配置">
      <div className="space-y-5">
        {ASR_DEFAULT_SECTIONS.map((section) => (
          <Section key={section.title}>
            <SectionHeader title={section.title} />
            <SectionContent>
              <SectionItemList>
                {section.fields.map((flatKey) => {
                  const value = getValue(flatKey);
                  const meta = getFieldMeta(flatKey, value);
                  return (
                    <SectionItem
                      key={flatKey}
                      title={meta.label}
                      action={renderControl(meta, value, (v) => handleChange(flatKey, v))}
                    />
                  );
                })}
              </SectionItemList>
            </SectionContent>
          </Section>
        ))}
      </div>
    </Modal>
  );
};
