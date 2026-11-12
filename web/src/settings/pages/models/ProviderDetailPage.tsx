/**
 * Inline provider editor: capability tabs, credentials and model management.
 * Reuses the existing configuration, testing and download flows.
 */

import {
  ChevronRight,
  CloudDownload,
  ExternalLink,
  Info,
  LoaderCircle,
  Plus,
  Trash2,
} from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { errText } from "@/i18n/errText";
import {
  deleteModel,
  downloadModel,
  listLlmModels,
  type ModelDownloadProgress,
  openExternalUrl,
  saveConfigObject,
} from "@/settings/bridge";
import { Badge } from "@/settings/components/Badge";
import { Button } from "@/settings/components/Button";
import { Modal } from "@/settings/components/Modal";
import { AddModelModal } from "@/settings/components/models/AddModelModal";
import { renderControl } from "@/settings/components/models/FieldControl";
import {
  AsrModelConfigModal,
  LlmModelConfigModal,
} from "@/settings/components/models/ModelConfigModal";
import { SegmentedControl } from "@/settings/components/SegmentedControl";
import { Toast, useToast } from "@/settings/components/Toast";
import { Tooltip } from "@/settings/components/Tooltip";
import {
  Section,
  SectionContent,
  SectionHeader,
  SectionItem,
  SectionItemList,
  SectionRows,
} from "@/settings/layout/PageLayout";
import { clonePlain } from "@/settings/lib/clone";
import { languageName } from "@/settings/lib/languages";
import {
  type AsrDefaults,
  effectiveDoubaoAuthMode,
  getFieldMeta,
  hasLegacyDoubaoCreds,
  isQwenModel,
  localizedModelFields,
  normalizeQwenSettings,
  resolveFieldMeta,
} from "@/settings/lib/model";
import {
  asRecord,
  asrCredentialDefault,
  asrCredentialValues,
  llmCredentialValues,
  localizedProviderFields,
  resolveDefaultLlmModel,
  sharedCredentialValues,
  viewRequestId,
  visibleAsrModels,
  visibleLlmModels,
  withAsrCredential,
  withAsrModelVisible,
  withDefaultLlmModel,
  withDoubaoBaseUrl,
  withLlmCredential,
  withLlmModels,
  withoutProvider,
  withSharedCredential,
} from "@/settings/lib/providers";
import { useSettings } from "@/settings/SettingsProvider";
import type {
  CapabilityKind,
  CredentialField,
  LlmModelEntry,
  RegistryModel,
  RegistryProvider,
} from "@/settings/types/models";

type Config = Record<string, unknown>;
type ModelModalState =
  | { kind: "asr"; model: RegistryModel }
  | { kind: "llm"; entryId: string }
  | null;

interface ProviderDetailPageProps {
  provider: RegistryProvider;
  providers: RegistryProvider[];
  models: RegistryModel[];
  asrDefaults: AsrDefaults | null;
  downloaded: string[];
  downloadProgress: Record<string, ModelDownloadProgress>;
  onDownloadedChange: () => Promise<void>;
  onBack: () => void;
}

export function ProviderDetailPage({
  provider,
  providers,
  models,
  asrDefaults,
  downloaded,
  downloadProgress,
  onDownloadedChange,
  onBack,
}: ProviderDetailPageProps) {
  const { t, i18n } = useTranslation();
  const { settings, refresh } = useSettings();
  const { toast, showToast } = useToast();

  const config = (settings?.parsedConfig || {}) as Config;
  const testConfig = useRef(config);
  const sourceConfig = useRef(config);
  if (sourceConfig.current !== config) {
    sourceConfig.current = config;
    testConfig.current = config;
  }
  const [tab, setTab] = useState<CapabilityKind>(provider.capabilities[0] ?? "asr");
  const [modelModal, setModelModal] = useState<ModelModalState>(null);
  const [addModelOpen, setAddModelOpen] = useState(false);
  const [newModel, setNewModel] = useState<LlmModelEntry | null>(null);
  const [savingModel, setSavingModel] = useState(false);
  const [removeProviderOpen, setRemoveProviderOpen] = useState(false);
  const [remoteModels, setRemoteModels] = useState<Array<{ id: string; name?: string }>>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const modelFetchSequence = useRef(0);

  // Full-config save (removals must bypass scheduleSave's deep merge).
  const save = useCallback(
    async (next: Config) => {
      testConfig.current = next;
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

  const { name: providerName } = localizedProviderFields(provider, i18n.language);
  const hasAsr = provider.capabilities.includes("asr");
  const hasLlm = provider.capabilities.includes("llm");
  const showTabs = hasAsr && hasLlm;

  const asrModels = useMemo(
    () => visibleAsrModels(asRecord(config.audio), provider.id, models),
    [config.audio, provider.id, models],
  );
  const hiddenAsrPresets = useMemo(() => {
    const all = models.filter((m) => m.provider === provider.id && m.category === "asr");
    return all.filter((m) => !asrModels.some((v) => v.id === m.id));
  }, [models, provider.id, asrModels]);
  const baseModels = useMemo(
    () =>
      provider.id === "local_asr"
        ? models.filter(
            (m) =>
              m.provider === "local_asr" && (m.category === "vad" || m.category === "punctuation"),
          )
        : [],
    [models, provider.id],
  );
  const llmModels = useMemo(
    () => visibleLlmModels(asRecord(config.llm), provider.id, models),
    [config.llm, provider.id, models],
  );
  const hiddenLlmPresets = useMemo(() => {
    const all = models.filter((m) => m.provider === provider.id && m.category === "llm");
    return all.filter((m) => !llmModels.some((v) => v.preset?.id === m.id));
  }, [models, provider.id, llmModels]);
  const currentLlm = useMemo(() => {
    const llm = asRecord(config.llm);
    const configuredProvider = typeof llm.provider === "string" ? llm.provider : "bytedance";
    const activeProvider =
      configuredProvider === "openai_compatible" ? "custom_openai" : configuredProvider;
    return activeProvider === provider.id ? resolveDefaultLlmModel(llm, provider.id, models) : null;
  }, [config.llm, provider.id, models]);
  const activeAsr = asRecord(config.audio).provider;
  const activeAsrId = typeof activeAsr === "string" ? activeAsr : "doubao-streaming";

  const isModelDownloaded = (m: RegistryModel) => m.type === "online" || downloaded.includes(m.id);
  const isDownloading = (id: string) => downloadProgress[id]?.status === "downloading";

  /* ---------- actions ---------- */

  const fetchModels = async () => {
    const sequence = ++modelFetchSequence.current;
    setFetchingModels(true);
    try {
      const result = await listLlmModels(provider.id);
      if (sequence !== modelFetchSequence.current) return;
      setRemoteModels(
        Array.isArray(result.data) ? result.data.filter((m) => typeof m.id === "string") : [],
      );
    } catch (error) {
      if (sequence === modelFetchSequence.current) showToast(errText(error), "error");
    } finally {
      if (sequence === modelFetchSequence.current) setFetchingModels(false);
    }
  };

  const removeProvider = async () => {
    setRemoveProviderOpen(false);
    await save(
      withoutProvider(
        config,
        provider.id,
        providers,
        models,
        (m) => m.type === "online" || downloaded.includes(m.id),
      ),
    );
    onBack();
  };

  const removeAsrModel = async (model: RegistryModel) => {
    setModelModal(null);
    if (model.type === "offline") {
      // Local model removal deletes the downloaded files; the row stays.
      try {
        await deleteModel(model.id);
      } catch (error) {
        showToast(errText(error), "error");
        return;
      }
      await onDownloadedChange();
      await refresh();
      return;
    }
    await save(withAsrModelVisible(config, model.id, false, models, isModelDownloaded));
  };

  const changeLlmModels = async (entries: LlmModelEntry[]) => {
    return save(withLlmModels(config, provider.id, entries, models));
  };

  const modelEntry =
    modelModal?.kind === "llm"
      ? (() => {
          const view = llmModels.find((v) => v.id === modelModal.entryId);
          if (!view) return null;
          const entry: LlmModelEntry = {
            id: view.id,
            name: view.name,
            model_id: view.modelIdOverride,
            params: view.params,
          };
          return { view, entry };
        })()
      : null;

  /* ---------- credential cards ---------- */

  const renderCredentialCard = (
    scope: "shared" | "asr" | "llm",
    fields: CredentialField[] | undefined,
  ) => {
    if (!fields || fields.length === 0) return null;
    const values =
      scope === "shared"
        ? sharedCredentialValues(config, provider.id)
        : scope === "llm"
          ? llmCredentialValues(config, provider.id)
          : asrCredentialValues(config, provider.id, models);

    // Doubao auth-mode aware visibility (legacy App ID/Token vs v2 API Key).
    const doubaoMode = provider.id === "bytedance" ? effectiveDoubaoAuthMode(values) : null;
    const doubaoHasLegacy = provider.id === "bytedance" && hasLegacyDoubaoCreds(values);
    const visibleFields = fields.filter((f) => {
      if (doubaoMode) {
        if (f.key === "auth_mode") return doubaoHasLegacy;
        if (f.key === "app_id" || f.key === "access_token") return doubaoMode === "legacy";
      }
      return true;
    });

    return (
      <Section aria-label={t("ui.models.credentials")}>
        <SectionContent>
          <SectionItemList>
            {visibleFields.map((field, index) => {
              const isDoubaoUrl =
                scope === "asr" && provider.id === "bytedance" && field.key === "url";
              const configuredUrl = String(values.url_base || values.url || "");
              const raw = isDoubaoUrl
                ? (configuredUrl || asrCredentialDefault(models, provider.id, "url")).replace(
                    /\/bigmodel_(async|nostream)\/?$/,
                    "",
                  )
                : String(
                    (scope === "asr" && provider.id === "qwen" && field.key === "url"
                      ? String(values.url ?? "").trim() ||
                        asrCredentialDefault(models, provider.id, "url")
                      : values[field.key]) ||
                      (scope === "llm" && field.key === "url"
                        ? provider.default_llm_url || ""
                        : ""),
                  );
              const placeholder =
                scope === "asr" && field.key === "url"
                  ? asrCredentialDefault(models, provider.id, "url")
                  : scope === "llm" && field.key === "url"
                    ? (provider.default_llm_url ?? "")
                    : undefined;
              // Doubao URL renders as the mode select via FIELD_META.
              const asrModel = models.find(
                (m) => m.provider === provider.id && m.category === "asr",
              );
              const meta = resolveFieldMeta(
                getFieldMeta(
                  field.key,
                  raw,
                  scope === "asr" && !isDoubaoUrl ? asrModel?.id : undefined,
                ),
                t,
              );
              if (field.type === "password") meta.type = "password";
              if (scope === "llm" && provider.id === "qwen" && field.key === "url") {
                meta.tooltip = t("field.qwen_llm_url.tooltip");
                meta.placeholder = provider.default_llm_url;
              } else if (scope === "llm" && field.key === "url") {
                meta.tooltip = t("field.llm_url.tooltip");
                meta.placeholder = provider.default_llm_url || "https://api.example.com/v1";
              }
              meta.placeholder = meta.placeholder ?? placeholder;
              const control = renderControl(meta, raw, (value) => {
                const next =
                  scope === "shared"
                    ? withSharedCredential(
                        config,
                        provider.id,
                        field.key as "url" | "api_key",
                        String(value),
                      )
                    : scope === "llm"
                      ? withLlmCredential(config, provider.id, field.key as "url", String(value))
                      : isDoubaoUrl
                        ? withDoubaoBaseUrl(config, String(value))
                        : withAsrCredential(config, provider.id, field.key, String(value), models);
                void save(next);
              });
              return (
                <SectionItem
                  key={field.key}
                  title={meta.label}
                  last={index === visibleFields.length - 1}
                  tooltip={meta.tooltip}
                  action={control}
                />
              );
            })}
          </SectionItemList>
        </SectionContent>
      </Section>
    );
  };

  /* ---------- model rows ---------- */

  const modelInfo = (model: RegistryModel) => {
    const capabilities = ["streaming", "hotwords", "punctuation", "itn"] as const;
    const labels = capabilities
      .filter((key) => model.capabilities?.[key])
      .map((key) => t(`ui.model.capability.${key}`));
    const languages = model.languages?.map((code) => languageName(code, i18n.language));
    if (!labels.length && !languages?.length) return null;
    return (
      <Tooltip
        label={t("ui.models.model_info")}
        content={
          <div className="space-y-1">
            {labels.length > 0 && <p>{labels.join(" · ")}</p>}
            {!!languages?.length && (
              <p>
                {t("ui.models.supported_languages")}: {languages.join(" · ")}
              </p>
            )}
          </div>
        }
      >
        <Info size={14} aria-hidden="true" />
      </Tooltip>
    );
  };

  const renderAsrRow = (model: RegistryModel) => {
    const { name } = localizedModelFields(model, i18n.language);
    const downloadedNow = isModelDownloaded(model);
    const progress = downloadProgress[model.id];
    const percent =
      typeof progress?.progress === "number"
        ? Math.max(0, Math.min(100, Math.round(progress.progress)))
        : 0;
    const canConfigure = model.type !== "offline" || downloadedNow;
    return (
      <div
        key={model.id}
        className="group relative flex min-h-11 items-center gap-2 border-b border-border-subtle px-3 py-2 last:border-b-0 hover:bg-fill-hover/40"
      >
        <button
          type="button"
          disabled={!canConfigure}
          aria-label={t("ui.models.configure_model", { model: name })}
          className="absolute inset-0 rounded-[inherit] focus-visible:ring-1 focus-visible:ring-accent-dim"
          onClick={() => setModelModal({ kind: "asr", model })}
        />
        <span className="pointer-events-none relative min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1">
            <span className="font-semibold break-words">{name}</span>
            <span className="pointer-events-auto">{modelInfo(model)}</span>
          </span>
          {model.type === "offline" && (
            <span className="text-xs text-text-muted">
              {t(downloadedNow ? "ui.models.downloaded" : "ui.models.not_downloaded")}
              {model.file_size ? ` · ${model.file_size} MB` : ""}
            </span>
          )}
          {isDownloading(model.id) && (
            <span className="mt-1 block h-1 w-40 max-w-full overflow-hidden rounded-full bg-fill-track">
              <span
                className="block h-full bg-accent transition-[width]"
                style={{ width: `${percent}%` }}
              />
            </span>
          )}
        </span>
        {activeAsrId === model.id && (
          <Badge variant="accent" size="xs" className="pointer-events-none relative shrink-0">
            {t("ui.models.current_badge")}
          </Badge>
        )}
        {canConfigure ? (
          <ChevronRight
            size={15}
            className="pointer-events-none relative shrink-0 text-text-muted"
          />
        ) : (
          <span className="relative">
            <Button
              variant="accent"
              disabled={isDownloading(model.id)}
              onClick={() => void downloadModel(model.id)}
            >
              {isDownloading(model.id) ? (
                <LoaderCircle size={14} className="animate-spin" />
              ) : (
                <CloudDownload size={14} />
              )}
              {t("ui.models.download")}
            </Button>
          </span>
        )}
      </div>
    );
  };

  const renderLlmRow = (view: (typeof llmModels)[number]) => {
    const displayName =
      view.name ??
      localizedModelFields(
        view.preset ?? {
          id: view.id,
          name: view.id,
          type: "online",
        },
        i18n.language,
      ).name;
    const isCurrent = currentLlm?.id === view.id;
    return (
      <button
        key={view.id}
        type="button"
        aria-label={t("ui.models.configure_model", { model: displayName })}
        className="flex min-h-11 w-full items-center gap-3 border-b border-border-subtle px-3 py-2 text-left last:border-b-0 hover:bg-fill-hover/40"
        onClick={() => setModelModal({ kind: "llm", entryId: view.id })}
      >
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="text-sm font-semibold text-text">{displayName}</span>
          </span>
        </span>
        {isCurrent && (
          <Badge variant="accent" size="xs">
            {t("ui.models.current_badge")}
          </Badge>
        )}
        <ChevronRight size={15} className="shrink-0 text-text-muted" />
      </button>
    );
  };

  const renderModelSection = (cap: CapabilityKind) => {
    if (cap === "asr") {
      return (
        <div className="space-y-2">
          <Section aria-label={t("ui.models.asr_models")}>
            <SectionRows>
              {asrModels.map(renderAsrRow)}
              {asrModels.length === 0 && (
                <p className="px-4 py-3 text-center text-sm text-text-muted">
                  {t("ui.models.no_models")}
                </p>
              )}
            </SectionRows>
          </Section>
          <div className="flex justify-start">
            <Button variant="ghost" onClick={() => setAddModelOpen(true)}>
              <Plus size={14} />
              {t("ui.models.add_model")}
            </Button>
          </div>
        </div>
      );
    }
    return (
      <div className="space-y-2">
        <Section aria-label={t("ui.models.llm_models")}>
          <SectionRows>
            {llmModels.map(renderLlmRow)}
            {llmModels.length === 0 && (
              <p className="px-4 py-3 text-center text-sm text-text-muted">
                {t("ui.models.no_models")}
              </p>
            )}
          </SectionRows>
        </Section>
        <div className="flex justify-start">
          <Button
            variant="ghost"
            onClick={() => {
              setAddModelOpen(true);
              void fetchModels();
            }}
          >
            <Plus size={14} />
            {t("ui.models.add_model")}
          </Button>
        </div>
      </div>
    );
  };

  const sharedFields = provider.credentials?.shared?.fields;
  const activeCapFields = provider.credentials?.[tab]?.fields;

  return (
    <section aria-label={providerName} className="space-y-3">
      <div className="flex items-center gap-2">
        {showTabs && (
          <SegmentedControl
            role="tablist"
            align="start"
            label={t("ui.models.capabilities")}
            value={tab}
            options={provider.capabilities.map((cap) => ({
              value: cap,
              label: t(cap === "asr" ? "ui.models.tab_asr" : "ui.models.tab_llm"),
            }))}
            onChange={(value) => setTab(value as CapabilityKind)}
          />
        )}

        <div className="ml-auto flex shrink-0 items-center justify-end gap-2">
          {provider.docs_url && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const url = `${provider.docs_url}${provider.id === "bytedance" && tab === "llm" ? "#text-models" : ""}`;
                void openExternalUrl(url).catch(() => showToast(t("ui.nav.help_error"), "error"));
              }}
            >
              {t(
                provider.docs_url.startsWith("https://voicepaste.dev/")
                  ? "ui.models.setup_guide"
                  : "ui.models.get_api_key",
              )}
              <ExternalLink size={13} />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            title={t("ui.models.remove_provider")}
            onClick={() => setRemoveProviderOpen(true)}
          >
            <Trash2 size={14} />
            <span className="sr-only">{t("ui.models.remove_provider")}</span>
          </Button>
        </div>
      </div>
      {renderCredentialCard("shared", sharedFields)}
      {activeCapFields && renderCredentialCard(tab, activeCapFields)}

      {hasAsr && (tab === "asr" || !showTabs) && renderModelSection("asr")}
      {baseModels.length > 0 && (tab === "asr" || !showTabs) && (
        <Section aria-label={t("ui.audio.base_models")}>
          <SectionHeader title={t("ui.audio.base_models")} />
          <SectionRows>{baseModels.map(renderAsrRow)}</SectionRows>
        </Section>
      )}
      {hasLlm && (tab === "llm" || !showTabs) && renderModelSection("llm")}

      {/* Modal */}
      {modelModal?.kind === "asr" && (
        <AsrModelConfigModal
          key={modelModal.model.id}
          model={modelModal.model}
          isCurrent={activeAsrId === modelModal.model.id}
          defaultDisabled={!isModelDownloaded(modelModal.model)}
          onSetDefault={
            modelModal.model.category === "asr"
              ? () => {
                  void save({
                    ...testConfig.current,
                    audio: { ...asRecord(testConfig.current.audio), provider: modelModal.model.id },
                  });
                }
              : undefined
          }
          testTarget={
            modelModal.model.category === "asr"
              ? {
                  providerId: provider.id,
                  modelId: modelModal.model.id,
                  capability: "asr",
                  getConfig: () => testConfig.current,
                  showToast,
                  disabled: !isModelDownloaded(modelModal.model),
                }
              : undefined
          }
          onClose={() => setModelModal(null)}
          userConfig={(() => {
            const audio = asRecord(config.audio);
            const modelConfig = asRecord(audio[modelModal.model.id]);
            if (modelModal.model.id !== "doubao-streaming") return modelConfig;
            const credentials = asRecord(asRecord(audio.credentials).bytedance);
            const url = String(
              credentials.url_base
                ? modelConfig.url || credentials.url || ""
                : credentials.url || modelConfig.url || "",
            );
            return {
              ...modelConfig,
              ...(url
                ? {
                    url: url.endsWith("/bigmodel_nostream")
                      ? "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream"
                      : "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async",
                  }
                : {}),
            };
          })()}
          asrDefaults={asrDefaults}
          onConfigChange={(modelId, patch) => {
            const audio = clonePlain(asRecord(config.audio));
            if (modelModal.model.category === "vad") {
              const defaults = asRecord(audio.asr_defaults);
              const vad = { ...asRecord(defaults.vad), ...asRecord(patch.vad) };
              void save({
                ...clonePlain(config),
                audio: { ...audio, asr_defaults: { ...defaults, vad } },
              });
              return;
            }
            if (modelId === "doubao-streaming" && typeof patch.url === "string") {
              const credentials = asRecord(audio.credentials);
              const bytedance = { ...asRecord(credentials.bytedance) };
              const legacyUrl = bytedance.url || asRecord(audio[modelId]).url;
              if (!bytedance.url_base && typeof legacyUrl === "string") {
                bytedance.url_base = legacyUrl.replace(/\/bigmodel_(async|nostream)\/?$/, "");
              }
              delete bytedance.url;
              audio.credentials = { ...credentials, bytedance };
            }
            const current = asRecord(audio[modelId]);
            const next = isQwenModel(modelId) ? normalizeQwenSettings(current) : { ...current };
            for (const [key, value] of Object.entries(patch)) {
              if (isNested(value) && isRecordValue(next[key])) {
                next[key] = { ...(next[key] as Config), ...(value as Config) };
              } else {
                next[key] = value;
              }
            }
            const nextAudio = { ...audio, [modelId]: next };
            void save({ ...clonePlain(config), audio: nextAudio });
          }}
          onReset={(modelId) => {
            const audio = { ...asRecord(config.audio) };
            if (modelModal.model.category === "vad") {
              const defaults = { ...asRecord(audio.asr_defaults) };
              delete defaults.vad;
              audio.asr_defaults = defaults;
              void save({ ...clonePlain(config), audio });
              return;
            }
            delete audio[modelId];
            void save({ ...clonePlain(config), audio });
          }}
          onRemove={(model) => void removeAsrModel(model)}
          removeLabel={
            modelModal.model.type === "offline"
              ? t("ui.models.delete_files")
              : t("ui.models.remove_model")
          }
        />
      )}
      {modelEntry && (
        <LlmModelConfigModal
          key={modelEntry.entry.id}
          entry={modelEntry.entry}
          onModelIdHelp={() => showToast(t("ui.models.model_id_description"), "success")}
          isCurrent={currentLlm?.id === modelEntry.entry.id}
          onSetDefault={() =>
            void save(withDefaultLlmModel(testConfig.current, provider.id, modelEntry.entry.id))
          }
          testTarget={{
            providerId: provider.id,
            modelId: modelEntry.entry.id,
            capability: "llm",
            getConfig: () => testConfig.current,
            showToast,
          }}
          presetName={
            modelEntry.view.preset
              ? localizedModelFields(modelEntry.view.preset, i18n.language).name
              : undefined
          }
          requestDefault={viewRequestId(modelEntry.view)}
          isCustom={!modelEntry.view.preset}
          onClose={() => setModelModal(null)}
          onChange={(entry) => {
            const entries = llmModels.map((v) =>
              v.id === entry.id
                ? entry
                : ({
                    id: v.id,
                    name: v.name,
                    model_id: v.modelIdOverride,
                    params: v.params,
                  } as LlmModelEntry),
            );
            void changeLlmModels(entries);
          }}
          onRemove={() => {
            setModelModal(null);
            void changeLlmModels(
              llmModels
                .filter((v) => v.id !== modelEntry.entry.id)
                .map((v) => ({
                  id: v.id,
                  name: v.name,
                  model_id: v.modelIdOverride,
                  params: v.params,
                })),
            );
          }}
        />
      )}
      {newModel && (
        <LlmModelConfigModal
          entry={newModel}
          requestDefault=""
          isCustom
          isNew
          saving={savingModel}
          onClose={() => setNewModel(null)}
          onChange={setNewModel}
          onSave={() => {
            const id = newModel.id.trim();
            const name = newModel.name?.trim();
            if (!id || !name || savingModel) return;
            if (llmModels.some((model) => model.id === id || viewRequestId(model) === id)) {
              showToast(t("ui.models.duplicate_model"), "error");
              return;
            }
            setSavingModel(true);
            void changeLlmModels([...llmModels.map(toEntry), { ...newModel, id, name }])
              .then((success) => {
                if (success) {
                  setNewModel(null);
                  setModelModal({ kind: "llm", entryId: id });
                }
              })
              .finally(() => setSavingModel(false));
          }}
        />
      )}

      {/* Add model */}
      <AddModelModal
        open={addModelOpen}
        onClose={() => setAddModelOpen(false)}
        hiddenPresets={tab === "asr" ? hiddenAsrPresets : hiddenLlmPresets}
        allowCustom={tab === "llm"}
        remoteModels={remoteModels.filter((m) => !llmModels.some((v) => viewRequestId(v) === m.id))}
        fetching={fetchingModels}
        onFetch={tab === "llm" ? () => void fetchModels() : undefined}
        onCreateCustom={() => setNewModel({ id: "", name: "" })}
        onRestorePreset={(modelId) => {
          if (tab === "asr") {
            void save(withAsrModelVisible(config, modelId, true, models, isModelDownloaded)).then(
              (success) => {
                const model = models.find((entry) => entry.id === modelId);
                if (success && model) setModelModal({ kind: "asr", model });
              },
            );
          } else {
            const entries: LlmModelEntry[] = llmModels.map((v) => ({
              id: v.id,
              name: v.name,
              model_id: v.modelIdOverride,
              params: v.params,
            }));
            void changeLlmModels([...entries, { id: modelId }]).then((success) => {
              if (success) setModelModal({ kind: "llm", entryId: modelId });
            });
          }
        }}
        onAddCustom={(id, name) => {
          if (llmModels.some((model) => viewRequestId(model) === id)) return;
          void changeLlmModels([...llmModels.map(toEntry), { id, name }]).then((success) => {
            if (success) setModelModal({ kind: "llm", entryId: id });
          });
        }}
      />

      {/* Remove provider confirm */}
      <Modal
        open={removeProviderOpen}
        onClose={() => setRemoveProviderOpen(false)}
        title={t("ui.models.remove_provider")}
      >
        <p className="text-sm text-text-dim">
          {t("ui.models.remove_provider_confirm", { provider: providerName })}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="accent" onClick={() => void removeProvider()}>
            <Trash2 size={14} />
            {t("ui.models.remove_provider")}
          </Button>
        </div>
      </Modal>

      <Toast toast={toast} />
    </section>
  );
}

function toEntry(v: {
  id: string;
  name?: string;
  modelIdOverride?: string;
  params?: LlmModelEntry["params"];
}): LlmModelEntry {
  return { id: v.id, name: v.name, model_id: v.modelIdOverride, params: v.params };
}

function isNested(value: unknown): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isRecordValue(value: unknown): value is Config {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
