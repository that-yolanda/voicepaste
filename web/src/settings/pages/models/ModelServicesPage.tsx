/** Default model pickers, inline provider editors and expandable provider catalog. */

import { ChevronDown, ChevronRight, Globe, Laptop, Plus, Settings } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { errText } from "@/i18n/errText";
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
import { Collapse } from "@/settings/components/Collapse";
import { ProviderIcon } from "@/settings/components/models/ProviderIcon";
import { Select } from "@/settings/components/Select";
import { Toast, useToast } from "@/settings/components/Toast";
import {
  PageLayout,
  Section,
  SectionContent,
  SectionHeader,
  SectionItem,
  SectionItemList,
  SectionRow,
  SectionRows,
} from "@/settings/layout/PageLayout";
import { clonePlain } from "@/settings/lib/clone";
import { type AsrDefaults, localizedModelFields } from "@/settings/lib/model";
import {
  allVisibleAsrModels,
  allVisibleLlmModels,
  asRecord,
  catalogProviders,
  localizedProviderFields,
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

const ASR_DEFAULTS_ID = "asr_defaults";

export function ModelServicesPage() {
  const { t, i18n } = useTranslation();
  const { settings, refresh } = useSettings();
  const { toast, showToast } = useToast();
  const config = (settings?.parsedConfig || {}) as Config;

  const [providers, setProviders] = useState<RegistryProvider[]>([]);
  const [models, setModels] = useState<RegistryModel[]>([]);
  const [downloaded, setDownloaded] = useState<string[]>([]);
  const [runtimeDefaults, setRuntimeDefaults] = useState<AsrDefaults | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<Record<string, ModelDownloadProgress>>(
    {},
  );
  const [detailProviderId, setDetailProviderId] = useState<string | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [addingProvider, setAddingProvider] = useState<string | null>(null);
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
      try {
        await saveConfigObject(next as never);
        await refresh();
        return true;
      } catch (error) {
        showToast(errText(error), "error");
        return false;
      }
    },
    [refresh, showToast],
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

  return (
    <PageLayout>
      {/* 当前使用 */}
      <Section aria-label={t("ui.models.current_models")} data-tour="models-defaults">
        <SectionContent>
          <SectionItemList>
            <DefaultsRow
              tourTarget="models-default-asr"
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
              last
              tourTarget="models-default-llm"
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
          </SectionItemList>
        </SectionContent>
      </Section>

      <Section aria-label={t("ui.models.provider_list")} data-tour="models-providers">
        <SectionHeader
          title={t("ui.models.provider_list")}
          action={
            <Button
              variant="ghost"
              size="icon"
              title={t("ui.audio.custom_config")}
              data-tour="models-custom-config"
              onClick={() => setCustomConfigOpen(true)}
            >
              <Settings size={16} />
              <span className="sr-only">{t("ui.audio.custom_config")}</span>
            </Button>
          }
        />
        <SectionRows>
          {visible.map((provider, index) => {
            const { name } = localizedProviderFields(provider, i18n.language);
            const expanded = detailProviderId === provider.id;
            const panelId = `provider-panel-${provider.id}`;
            return (
              <div
                key={provider.id}
                className={index < visible.length - 1 ? "border-b border-border-subtle" : undefined}
              >
                <SectionRow
                  aria-expanded={expanded}
                  aria-controls={panelId}
                  onClick={() => {
                    setDetailProviderId(expanded ? null : provider.id);
                    setCatalogOpen(false);
                  }}
                >
                  <ProviderIcon provider={provider} />
                  <span className="min-w-0 font-semibold">{name}</span>
                  {provider.kind === "local" ? (
                    <Laptop size={14} aria-label={t("ui.models.filter_local")} />
                  ) : (
                    <Globe size={14} aria-label={t("ui.models.filter_online")} />
                  )}
                  <span className="flex flex-wrap gap-1">
                    {provider.capabilities.map((cap) => (
                      <Badge key={cap} size="xs">
                        {t(cap === "asr" ? "ui.models.tag_asr" : "ui.models.tag_llm")}
                      </Badge>
                    ))}
                  </span>
                  <ChevronRight
                    size={15}
                    className={`ml-auto shrink-0 transition-transform motion-reduce:transition-none ${expanded ? "rotate-90" : ""}`}
                  />
                </SectionRow>
                <Collapse open={expanded} id={panelId}>
                  <div className="bg-surface-expanded px-3 pb-3 pt-1" data-tour="model-detail">
                    <ProviderDetailPage
                      provider={provider}
                      providers={providers}
                      models={models}
                      asrDefaults={asrDefaults}
                      downloaded={downloaded}
                      downloadProgress={downloadProgress}
                      onDownloadedChange={refreshDownloaded}
                      onBack={() => setDetailProviderId(null)}
                    />
                  </div>
                </Collapse>
              </div>
            );
          })}
          {catalog.length > 0 && (
            <>
              <Collapse open={catalogOpen} id="provider-catalog">
                <div className="divide-y divide-border-subtle border-t border-border-subtle">
                  {catalog.map((provider) => (
                    <SectionRow
                      key={provider.id}
                      disabled={addingProvider !== null}
                      onClick={async () => {
                        setAddingProvider(provider.id);
                        try {
                          if (
                            await save(withAddedProvider(clonePlain(config), provider.id, models))
                          ) {
                            setDetailProviderId(provider.id);
                            setCatalogOpen(false);
                          }
                        } finally {
                          setAddingProvider(null);
                        }
                      }}
                    >
                      <ProviderIcon provider={provider} />
                      <span className="min-w-0 font-semibold">
                        {localizedProviderFields(provider, i18n.language).name}
                      </span>
                      {provider.kind === "local" ? (
                        <Laptop size={14} aria-label={t("ui.models.filter_local")} />
                      ) : (
                        <Globe size={14} aria-label={t("ui.models.filter_online")} />
                      )}
                      {provider.capabilities.map((cap) => (
                        <Badge key={cap} size="xs">
                          {t(cap === "asr" ? "ui.models.tag_asr" : "ui.models.tag_llm")}
                        </Badge>
                      ))}
                      <Plus size={14} className="ml-auto shrink-0" />
                    </SectionRow>
                  ))}
                </div>
              </Collapse>
              <div data-tour="models-add-provider">
                <button
                  type="button"
                  aria-expanded={catalogOpen}
                  aria-controls="provider-catalog"
                  className="flex min-h-9 w-full items-center justify-center gap-1 border-t border-border-subtle text-xs text-text-muted hover:bg-fill-hover"
                  onClick={() => {
                    setCatalogOpen(!catalogOpen);
                    setDetailProviderId(null);
                  }}
                >
                  {t(
                    catalogOpen
                      ? "ui.models.collapse_providers"
                      : visible.length === 0
                        ? "ui.models.add_provider"
                        : "ui.models.show_remaining_providers",
                    { count: catalog.length },
                  )}
                  <ChevronDown
                    size={13}
                    className={`transition-transform motion-reduce:transition-none ${catalogOpen ? "rotate-180" : ""}`}
                  />
                </button>
              </div>
            </>
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

      <Toast toast={toast} />
    </PageLayout>
  );
}

function DefaultsRow({
  label,
  tourTarget,
  value,
  options,
  onChange,
  last = false,
}: {
  label: string;
  tourTarget: string;
  last?: boolean;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <SectionItem
      title={label}
      last={last}
      action={
        <div data-tour={tourTarget} className="w-full">
          <Select
            aria-label={label}
            value={options.some((o) => o.value === value) ? value : ""}
            options={
              options.some((o) => o.value === value)
                ? options
                : [{ value: "", label: "—" }, ...options]
            }
            onChange={onChange}
          />
        </div>
      }
    />
  );
}
