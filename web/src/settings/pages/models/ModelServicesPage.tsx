/**
 * 模型服务 main page: 当前默认 card (语音识别 / 文本润色 pickers), the
 * 全部/在线/本地 filter, 自定义配置 + 添加供应商 actions and the provider
 * list. Owns registry/download state and the main ↔ provider detail
 * navigation; the detail page renders in place of the list.
 */

import { ChevronRight, Cog, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  getAudioConfigDefaults,
  getDownloadedModels,
  getModelRegistry,
  type ModelDownloadProgress,
  onModelDownloadProgress,
  saveConfigObject,
} from "@/settings/bridge";
import { Badge } from "@/settings/components/Badge";
import { Button } from "@/settings/components/Button";
import {
  AddProviderModal,
  localizedProviderFields,
} from "@/settings/components/models/AddProviderModal";
import { ProviderIcon } from "@/settings/components/models/ProviderIcon";
import { SegmentedControl } from "@/settings/components/SegmentedControl";
import { Select } from "@/settings/components/Select";
import { PageLayout, Section, SectionContent, SectionRows } from "@/settings/layout/PageLayout";
import { clonePlain } from "@/settings/lib/clone";
import { type AsrDefaults, localizedModelFields } from "@/settings/lib/model";
import {
  allVisibleAsrModels,
  allVisibleLlmModels,
  asRecord,
  catalogProviders,
  resolveDefaultLlmModel,
  visibleProviders,
  withAddedProvider,
  withDefaultLlmModel,
} from "@/settings/lib/providers";
import { useSettings } from "@/settings/SettingsProvider";
import type { RegistryModel, RegistryProvider } from "@/settings/types/models";
import { CustomConfigModal, isRecord, mergeRuntimeAsrDefaults } from "./CustomConfigModal";
import { ProviderDetailPage } from "./ProviderDetailPage";

type Config = Record<string, unknown>;
type Filter = "all" | "online" | "local";

const ASR_DEFAULTS_ID = "asr_defaults";

export function ModelServicesPage() {
  const { t, i18n } = useTranslation();
  const { settings, refresh } = useSettings();
  const config = (settings?.parsedConfig || {}) as Config;

  const [providers, setProviders] = useState<RegistryProvider[]>([]);
  const [models, setModels] = useState<RegistryModel[]>([]);
  const [downloaded, setDownloaded] = useState<string[]>([]);
  const [runtimeDefaults, setRuntimeDefaults] = useState<AsrDefaults | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<Record<string, ModelDownloadProgress>>(
    {},
  );
  const [filter, setFilter] = useState<Filter>("all");
  const [detailProviderId, setDetailProviderId] = useState<string | null>(null);
  const [addProviderOpen, setAddProviderOpen] = useState(false);
  const [customConfigOpen, setCustomConfigOpen] = useState(false);
  const mounted = useRef(false);

  /* ---------- data loading ---------- */

  useEffect(() => {
    mounted.current = true;
    getAudioConfigDefaults()
      .then((defaults) => {
        if (mounted.current && isRecord(defaults))
          setRuntimeDefaults(defaults as unknown as AsrDefaults);
      })
      .catch(() => {});
    return () => {
      mounted.current = false;
    };
  }, []);

  const refreshDownloaded = useCallback(async () => {
    try {
      const ids = await getDownloadedModels();
      if (mounted.current) setDownloaded(Array.isArray(ids) ? ids : []);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    getModelRegistry()
      .then(({ providers: p, models: m }) => {
        if (!mounted.current) return;
        setProviders(p as RegistryProvider[]);
        setModels(m as RegistryModel[]);
      })
      .catch(() => {});
    void refreshDownloaded();
  }, [refreshDownloaded]);

  useEffect(
    () =>
      onModelDownloadProgress((p) => {
        setDownloadProgress((prev) => ({ ...prev, [p.model_id]: p }));
        if (p.status === "completed") void refreshDownloaded();
      }),
    [refreshDownloaded],
  );

  const audio = asRecord(config.audio);
  const asrDefaults = useMemo(
    () => mergeRuntimeAsrDefaults(runtimeDefaults, audio),
    [runtimeDefaults, audio],
  );

  const save = useCallback(
    async (next: Config) => {
      await saveConfigObject(next as never);
      await refresh();
    },
    [refresh],
  );

  /* ---------- derived ---------- */

  const visible = useMemo(
    () => visibleProviders(config, providers, models),
    [config, providers, models],
  );
  const catalog = useMemo(
    () => catalogProviders(config, providers, models),
    [config, providers, models],
  );
  const filtered = visible.filter((p) => filter === "all" || p.kind === filter);

  const asrCandidates = useMemo(
    () =>
      allVisibleAsrModels(config, providers, models).filter(
        ({ model }) => model.type === "online" || downloaded.includes(model.id),
      ),
    [config, providers, models, downloaded],
  );
  const llmCandidates = useMemo(
    () => allVisibleLlmModels(config, providers, models),
    [config, providers, models],
  );

  const activeAsrId = typeof audio.provider === "string" ? audio.provider : "doubao-streaming";
  const llm = asRecord(config.llm);
  const activeLlmProvider =
    typeof llm.provider !== "string"
      ? "bytedance"
      : llm.provider === "openai_compatible"
        ? "custom_openai"
        : llm.provider;
  const resolvedLlm =
    typeof activeLlmProvider === "string"
      ? resolveDefaultLlmModel(llm, activeLlmProvider, models)
      : null;
  const defaultLlmEntry = llmCandidates.find(
    ({ provider, model }) => provider.id === activeLlmProvider && model.id === resolvedLlm?.id,
  );
  // Fallback for legacy configs: first visible entry of the active provider.
  const defaultLlm =
    defaultLlmEntry ??
    llmCandidates.find(({ provider }) => provider.id === activeLlmProvider) ??
    llmCandidates[0];

  const detailProvider = detailProviderId ? providers.find((p) => p.id === detailProviderId) : null;

  /* ---------- asr_defaults writers (CustomConfigModal) ---------- */

  const saveAsrDefaults = useCallback(
    async (updates: Record<string, unknown>) => {
      const current = isRecord(audio[ASR_DEFAULTS_ID]) ? clonePlain(audio[ASR_DEFAULTS_ID]) : {};
      const next = { ...current, ...updates };
      if (updates.provider) next.provider = String(updates.provider).toLowerCase();
      await save({ ...clonePlain(config), audio: { ...audio, [ASR_DEFAULTS_ID]: next } });
    },
    [audio, config, save],
  );

  const saveAsrVadDefaults = useCallback(
    async (updates: Record<string, unknown>) => {
      const current = isRecord(audio[ASR_DEFAULTS_ID]) ? clonePlain(audio[ASR_DEFAULTS_ID]) : {};
      const currentVad = isRecord(current.vad) ? current.vad : {};
      await saveAsrDefaults({ vad: { ...currentVad, ...updates } });
    },
    [audio, saveAsrDefaults],
  );

  if (detailProvider) {
    return (
      <PageLayout data-tour="model-detail">
        <ProviderDetailPage
          provider={detailProvider}
          providers={providers}
          models={models}
          asrDefaults={asrDefaults}
          downloaded={downloaded}
          downloadProgress={downloadProgress}
          onDownloadedChange={refreshDownloaded}
          onBack={() => setDetailProviderId(null)}
        />
      </PageLayout>
    );
  }

  return (
    <PageLayout>
      {/* 当前默认 */}
      <Section aria-label={t("ui.models.current_defaults")} data-tour="models-defaults">
        <SectionContent>
          <DefaultsRow
            label={t("ui.models.tab_asr")}
            value={activeAsrId}
            options={asrCandidates.map(({ provider, model }) => ({
              value: model.id,
              label: `${localizedProviderFields(provider, i18n.language).name} / ${localizedModelFields(model, i18n.language).name}`,
            }))}
            onChange={(modelId) =>
              void save({ ...clonePlain(config), audio: { ...audio, provider: modelId } })
            }
          />
          <DefaultsRow
            label={t("ui.models.tab_llm")}
            value={defaultLlm ? `${defaultLlm.provider.id}::${defaultLlm.model.id}` : ""}
            options={llmCandidates.map(({ provider, model }) => ({
              value: `${provider.id}::${model.id}`,
              label: `${localizedProviderFields(provider, i18n.language).name} / ${model.name ?? localizedModelFields(model.preset ?? { id: model.id, name: model.id, type: "online" }, i18n.language).name}`,
            }))}
            onChange={(value) => {
              const [providerId, modelId] = value.split("::");
              void save(withDefaultLlmModel(clonePlain(config), providerId, modelId));
            }}
          />
        </SectionContent>
      </Section>

      {/* filter row */}
      <div className="flex items-center gap-2" data-tour="models-filter">
        <SegmentedControl
          options={[
            { value: "all", label: t("ui.models.filter_all") },
            { value: "online", label: t("ui.models.filter_online") },
            { value: "local", label: t("ui.models.filter_local") },
          ]}
          value={filter}
          onChange={(v) => setFilter(v as Filter)}
        />
        <Button
          className="ml-auto"
          variant="ghost"
          data-tour="models-custom-config"
          onClick={() => setCustomConfigOpen(true)}
        >
          <Cog size={15} />
          {t("ui.audio.custom_config")}
        </Button>
        <Button variant="accent" onClick={() => setAddProviderOpen(true)}>
          <Plus size={14} />
          {t("ui.models.add_provider")}
        </Button>
      </div>

      {/* provider list */}
      <Section aria-label={t("ui.models.provider_list")} data-tour="models-providers">
        <SectionRows>
          {filtered.map((provider) => {
            const { name } = localizedProviderFields(provider, i18n.language);
            return (
              <button
                key={provider.id}
                type="button"
                className="flex w-full min-h-14 items-center gap-3 border-b border-border-subtle px-4 py-2.5 text-left last:border-b-0 hover:bg-fill-hover/40"
                onClick={() => setDetailProviderId(provider.id)}
              >
                <ProviderIcon provider={provider} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-text">{name}</span>
                  <span className="mt-0.5 flex items-center gap-1">
                    {provider.capabilities.map((cap) => (
                      <Badge key={cap} variant="default" size="xs">
                        {t(cap === "asr" ? "ui.models.tag_asr" : "ui.models.tag_llm")}
                      </Badge>
                    ))}
                    {provider.kind === "local" && (
                      <Badge variant="success" size="xs">
                        {t("ui.models.tag_local")}
                      </Badge>
                    )}
                  </span>
                </span>
                <ChevronRight size={15} className="shrink-0 text-text-muted" />
              </button>
            );
          })}
          {filtered.length === 0 && (
            <p className="px-4 py-3 text-center text-sm text-text-muted">
              {t("ui.models.no_providers")}
            </p>
          )}
        </SectionRows>
      </Section>

      <CustomConfigModal
        open={customConfigOpen}
        onClose={() => setCustomConfigOpen(false)}
        asrDefaults={asrDefaults}
        saveAsrDefaults={saveAsrDefaults}
        saveAsrVadDefaults={saveAsrVadDefaults}
      />

      <AddProviderModal
        open={addProviderOpen}
        onClose={() => setAddProviderOpen(false)}
        catalog={catalog}
        onAdd={async (providerId) => {
          await save(withAddedProvider(clonePlain(config), providerId, models));
          setDetailProviderId(providerId);
        }}
      />
    </PageLayout>
  );
}

function DefaultsRow({
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
    <div className="grid min-h-12 grid-cols-2 items-center gap-2 border-b border-border-subtle py-1.5 last:border-b-0">
      <span className="flex-1 text-sm font-semibold text-text">{label}</span>
      <Select
        aria-label={label}
        value={options.some((o) => o.value === value) ? value : ""}
        options={
          options.some((o) => o.value === value) ? options : [{ value: "", label: "—" }, ...options]
        }
        onChange={onChange}
      />
    </div>
  );
}
