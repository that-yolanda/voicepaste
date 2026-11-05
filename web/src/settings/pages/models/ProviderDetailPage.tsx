/**
 * Provider detail page: back link, provider header (如何申请 / 移除),
 * capability tabs (语音识别 / 大语言), two-scope credential cards and the
 * provider's model list. Local providers render the same structure without
 * tabs or credentials (本地语音识别模型 + 基础组件).
 */

import {
  ArrowLeft,
  Check,
  ChevronRight,
  Cloud,
  CloudDownload,
  Cpu,
  ExternalLink,
  LoaderCircle,
  Plus,
  Trash2,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { errText } from "@/i18n/errText";
import {
  deleteModel,
  downloadModel,
  type ModelDownloadProgress,
  saveConfigObject,
  testProviderConnection,
} from "@/settings/bridge";
import { Badge } from "@/settings/components/Badge";
import { Button } from "@/settings/components/Button";
import { Modal } from "@/settings/components/Modal";
import { AddModelModal } from "@/settings/components/models/AddModelModal";
import { localizedProviderFields } from "@/settings/components/models/AddProviderModal";
import { renderControl } from "@/settings/components/models/FieldControl";
import {
  AsrModelConfigDrawer,
  LlmModelConfigDrawer,
} from "@/settings/components/models/ModelConfigDrawer";
import { Toast, useToast } from "@/settings/components/Toast";
import {
  Section,
  SectionContent,
  SectionHeader,
  SectionItem,
  SectionItemList,
} from "@/settings/layout/PageLayout";
import { clonePlain } from "@/settings/lib/clone";
import { languageName } from "@/settings/lib/languages";
import {
  type AsrDefaults,
  effectiveDoubaoAuthMode,
  getFieldMeta,
  hasLegacyDoubaoCreds,
  localizedModelFields,
  resolveFieldMeta,
} from "@/settings/lib/model";
import {
  asRecord,
  asrCredentialDefault,
  asrCredentialValues,
  credentialsFilled,
  llmCredentialValues,
  resolveDefaultLlmModel,
  sharedCredentialValues,
  viewRequestId,
  visibleAsrModels,
  visibleLlmModels,
  withAsrCredential,
  withAsrModelVisible,
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
type DrawerState = { kind: "asr"; model: RegistryModel } | { kind: "llm"; entryId: string } | null;

interface ProviderDetailPageProps {
  provider: RegistryProvider;
  providers: RegistryProvider[];
  models: RegistryModel[];
  asrDefaults: AsrDefaults | null;
  downloaded: string[];
  downloadProgress: Record<string, ModelDownloadProgress>;
  onBack: () => void;
}

export function ProviderDetailPage({
  provider,
  providers,
  models,
  asrDefaults,
  downloaded,
  downloadProgress,
  onBack,
}: ProviderDetailPageProps) {
  const { t, i18n } = useTranslation();
  const { settings, refresh } = useSettings();
  const { toast, showToast } = useToast();

  const config = (settings?.parsedConfig || {}) as Config;
  const [tab, setTab] = useState<CapabilityKind>(provider.capabilities[0] ?? "asr");
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [addModelOpen, setAddModelOpen] = useState(false);
  const [removeProviderOpen, setRemoveProviderOpen] = useState(false);
  const [testing, setTesting] = useState(false);

  // Full-config save (removals must bypass scheduleSave's deep merge).
  const save = useCallback(
    async (next: Config) => {
      try {
        await saveConfigObject(next as never);
        await refresh();
      } catch (error) {
        showToast(errText(error), "error");
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
  const defaultLlm = useMemo(
    () => resolveDefaultLlmModel(asRecord(config.llm), provider.id, models),
    [config.llm, provider.id, models],
  );
  const activeAsrId = (asRecord(config.audio).provider as string) || "doubao-streaming";

  const isModelDownloaded = (m: RegistryModel) => m.type === "online" || downloaded.includes(m.id);
  const isDownloading = (id: string) => downloadProgress[id]?.status === "downloading";

  /* ---------- actions ---------- */

  const runTest = async () => {
    setTesting(true);
    try {
      await testProviderConnection(provider.id, tab);
      showToast(t("ui.models.test_ok", { provider: providerName }), "success");
    } catch (error) {
      showToast(errText(error), "error");
    } finally {
      setTesting(false);
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
    setDrawer(null);
    if (model.type === "offline") {
      // Local model removal deletes the downloaded files; the row stays.
      try {
        await deleteModel(model.id);
      } catch (error) {
        showToast(errText(error), "error");
        return;
      }
      await refresh();
      return;
    }
    await save(withAsrModelVisible(config, model.id, false, models));
  };

  const changeLlmModels = async (entries: LlmModelEntry[]) => {
    await save(withLlmModels(config, provider.id, entries));
  };

  const drawerEntry =
    drawer?.kind === "llm"
      ? (() => {
          const view = llmModels.find((v) => v.id === drawer.entryId);
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
    const filled = credentialsFilled(values, fields);

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
        <SectionHeader
          title={t("ui.models.credentials")}
          action={
            <div className="flex items-center gap-2">
              {filled ? (
                <span
                  className="grid size-6 place-items-center rounded-md bg-success/10 text-success"
                  title={t("ui.models.credentials_filled")}
                >
                  <Check size={14} />
                </span>
              ) : null}
              {provider.kind === "online" && (
                <Button variant="ghost" disabled={testing} onClick={() => void runTest()}>
                  {testing ? <LoaderCircle size={14} className="animate-spin" /> : null}
                  {t("ui.models.test")}
                </Button>
              )}
            </div>
          }
        />
        <SectionContent>
          <SectionItemList>
            {visibleFields.map((field) => {
              const raw = String(values[field.key] ?? "");
              const placeholder =
                scope === "asr" && field.key === "url"
                  ? asrCredentialDefault(models, provider.id, "url")
                  : scope === "llm" && field.key === "url"
                    ? (provider.default_llm_url ?? "")
                    : undefined;
              // Doubao URL renders as the mode select via FIELD_META.
              const meta = resolveFieldMeta(getFieldMeta(field.key, raw, asrModels[0]?.id), t);
              if (field.type === "password") meta.type = "password";
              meta.placeholder = meta.placeholder ?? placeholder;
              const control = renderControl(meta, raw, (value) => {
                const next =
                  scope === "shared"
                    ? withSharedCredential(config, provider.id, "url", String(value))
                    : scope === "llm"
                      ? withLlmCredential(config, provider.id, field.key as "url", String(value))
                      : withAsrCredential(config, provider.id, field.key, String(value), models);
                void save(next);
              });
              return (
                <SectionItem
                  key={field.key}
                  title={meta.label}
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

  const renderModelMeta = (model: RegistryModel) => {
    const parts: string[] = [];
    if (model.file_size) parts.push(`${model.file_size} MB`);
    if (model.languages?.length) {
      parts.push(
        model.languages
          .slice(0, 3)
          .map((code) => languageName(code, i18n.language))
          .join(" · "),
      );
    }
    if (model.capabilities?.streaming) parts.push(t("ui.model.capability.streaming"));
    return parts.join(" · ");
  };

  const renderAsrRow = (model: RegistryModel) => {
    const { name } = localizedModelFields(model, i18n.language);
    const downloadedNow = isModelDownloaded(model);
    const progress = downloadProgress[model.id];
    const percent =
      typeof progress?.progress === "number"
        ? Math.max(0, Math.min(100, Math.round(progress.progress)))
        : 0;
    return (
      <div
        key={model.id}
        className="flex min-h-14 items-center gap-3 border-b border-border-subtle py-2 last:border-b-0 hover:bg-fill-hover/40"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-text">{name}</span>
            {activeAsrId === model.id && (
              <Badge variant="accent" size="xs">
                {t("ui.models.default_badge")}
              </Badge>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-text-muted">
            {model.type === "offline" &&
              (downloadedNow ? (
                <span className="text-success">{t("ui.models.downloaded")}</span>
              ) : (
                <span>{t("ui.models.not_downloaded")}</span>
              ))}
            <span className="truncate">{renderModelMeta(model)}</span>
          </div>
          {isDownloading(model.id) && (
            <div className="mt-1 h-1.5 w-40 overflow-hidden rounded-full bg-fill-track">
              <div
                className="h-full rounded-full bg-accent transition-[width]"
                style={{ width: `${percent}%` }}
              />
            </div>
          )}
        </div>
        {model.type === "offline" && !downloadedNow ? (
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
        ) : (
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("ui.models.configure_model", { model: name })}
            onClick={() => setDrawer({ kind: "asr", model })}
          >
            <ChevronRight size={15} />
          </Button>
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
    const isDefault = defaultLlm?.id === view.id;
    return (
      <div
        key={view.id}
        className="flex min-h-14 items-center gap-3 border-b border-border-subtle py-2 last:border-b-0 hover:bg-fill-hover/40"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-text">{displayName}</span>
            {isDefault && (
              <Badge variant="accent" size="xs">
                {t("ui.models.default_badge")}
              </Badge>
            )}
            {!view.preset && (
              <Badge variant="ghost" size="xs">
                {t("ui.models.custom_model")}
              </Badge>
            )}
          </div>
          <div className="mt-0.5 truncate text-xs text-text-muted">{viewRequestId(view)}</div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("ui.models.configure_model", { model: displayName })}
          onClick={() => setDrawer({ kind: "llm", entryId: view.id })}
        >
          <ChevronRight size={15} />
        </Button>
      </div>
    );
  };

  const renderModelSection = (cap: CapabilityKind) => {
    if (cap === "asr") {
      return (
        <Section aria-label={t("ui.models.asr_models")}>
          <SectionHeader
            title={t("ui.models.asr_models")}
            action={
              <Button variant="ghost" onClick={() => setAddModelOpen(true)}>
                <Plus size={14} />
                {t("ui.models.add_model")}
              </Button>
            }
          />
          <SectionContent className="px-0 pb-0">
            {asrModels.map(renderAsrRow)}
            {asrModels.length === 0 && (
              <p className="px-4 py-3 text-sm text-text-muted">{t("ui.models.no_models")}</p>
            )}
          </SectionContent>
        </Section>
      );
    }
    return (
      <Section aria-label={t("ui.models.llm_models")}>
        <SectionHeader
          title={t("ui.models.llm_models")}
          action={
            <Button variant="ghost" onClick={() => setAddModelOpen(true)}>
              <Plus size={14} />
              {t("ui.models.add_model")}
            </Button>
          }
        />
        <SectionContent className="px-0 pb-0">
          {llmModels.map(renderLlmRow)}
          {llmModels.length === 0 && (
            <p className="px-4 py-3 text-sm text-text-muted">{t("ui.models.no_models")}</p>
          )}
        </SectionContent>
      </Section>
    );
  };

  const sharedFields = provider.credentials?.shared?.fields;
  const activeCapFields = provider.credentials?.[tab]?.fields;

  return (
    <div className="space-y-4">
      <button
        type="button"
        className="inline-flex h-6 items-center gap-1.5 text-xs text-text-muted hover:text-text"
        onClick={onBack}
      >
        <ArrowLeft size={13} />
        {t("ui.models.back_to_services")}
      </button>

      <header className="flex items-center gap-3">
        <span
          className={`grid size-11 place-items-center rounded-xl border border-border-subtle ${
            provider.kind === "local" ? "text-text-dim" : "text-accent"
          }`}
        >
          {provider.kind === "local" ? <Cpu size={22} /> : <Cloud size={22} />}
        </span>
        <h1 className="flex-1 text-xl font-semibold text-text">{providerName}</h1>
        <div className="flex items-center gap-3">
          {provider.docs_url && (
            <a
              className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
              href={provider.docs_url}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink size={12} />
              {t("ui.models.how_to_apply")}
            </a>
          )}
          <Button variant="ghost" onClick={() => setRemoveProviderOpen(true)}>
            <Trash2 size={14} />
            {t("ui.models.remove_provider")}
          </Button>
        </div>
      </header>

      {renderCredentialCard("shared", sharedFields)}

      {showTabs && (
        <div
          role="tablist"
          aria-label={t("ui.models.capabilities")}
          className="flex gap-5 border-b border-border"
        >
          {provider.capabilities.map((cap) => (
            <button
              key={cap}
              type="button"
              role="tab"
              aria-selected={tab === cap}
              className={`relative h-9 text-sm ${
                tab === cap
                  ? "font-semibold text-text after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-t after:bg-accent"
                  : "text-text-muted hover:text-text"
              }`}
              onClick={() => setTab(cap)}
            >
              {t(cap === "asr" ? "ui.models.tab_asr" : "ui.models.tab_llm")}
            </button>
          ))}
        </div>
      )}

      {!showTabs && activeCapFields && renderCredentialCard(tab, activeCapFields)}
      {showTabs && activeCapFields && renderCredentialCard(tab, activeCapFields)}

      {hasAsr && (tab === "asr" || !showTabs) && renderModelSection("asr")}
      {baseModels.length > 0 && (tab === "asr" || !showTabs) && (
        <Section aria-label={t("ui.audio.base_models")}>
          <SectionHeader title={t("ui.audio.base_models")} />
          <SectionContent className="px-0 pb-0">{baseModels.map(renderAsrRow)}</SectionContent>
        </Section>
      )}
      {hasLlm && (tab === "llm" || !showTabs) && renderModelSection("llm")}

      {/* Drawer */}
      {drawer?.kind === "asr" && (
        <AsrModelConfigDrawer
          model={drawer.model}
          onClose={() => setDrawer(null)}
          userConfig={asRecord(asRecord(config.audio)[drawer.model.id])}
          asrDefaults={asrDefaults}
          onConfigChange={(modelId, patch) => {
            const audio = asRecord(config.audio);
            const current = asRecord(audio[modelId]);
            const next = { ...current };
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
            delete audio[modelId];
            void save({ ...clonePlain(config), audio });
          }}
          onRemove={(model) => void removeAsrModel(model)}
          removeLabel={
            drawer.model.type === "offline"
              ? t("ui.models.delete_files")
              : t("ui.models.remove_model")
          }
        />
      )}
      {drawerEntry && (
        <LlmModelConfigDrawer
          entry={drawerEntry.entry}
          presetName={
            drawerEntry.view.preset
              ? localizedModelFields(drawerEntry.view.preset, i18n.language).name
              : undefined
          }
          requestDefault={viewRequestId(drawerEntry.view)}
          isCustom={!drawerEntry.view.preset}
          onClose={() => setDrawer(null)}
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
            setDrawer(null);
            void changeLlmModels(
              llmModels
                .filter((v) => v.id !== drawerEntry.entry.id)
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

      {/* Add model */}
      <AddModelModal
        open={addModelOpen}
        onClose={() => setAddModelOpen(false)}
        hiddenPresets={tab === "asr" ? hiddenAsrPresets : hiddenLlmPresets}
        allowCustom={tab === "llm"}
        onRestorePreset={(modelId) => {
          if (tab === "asr") {
            void save(withAsrModelVisible(config, modelId, true, models));
          } else {
            const entries: LlmModelEntry[] = llmModels.map((v) => ({
              id: v.id,
              name: v.name,
              model_id: v.modelIdOverride,
              params: v.params,
            }));
            void changeLlmModels([...entries, { id: modelId }]);
          }
        }}
        onAddCustom={(id, name) => {
          void changeLlmModels([...llmModels.map(toEntry), { id, name }]);
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
          <Button variant="ghost" onClick={() => setRemoveProviderOpen(false)}>
            {t("ui.common.cancel")}
          </Button>
          <Button variant="accent" onClick={() => void removeProvider()}>
            <Trash2 size={14} />
            {t("ui.models.remove_provider")}
          </Button>
        </div>
      </Modal>

      <Toast toast={toast} />
    </div>
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
