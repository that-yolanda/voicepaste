/**
 * Unified card for rendering any ASR model (online Doubao, offline ASR, base
 * vad/punctuation models). One rendering path, no per-model branching.
 *
 * Field rendering is data-driven: each field key is resolved via FIELD_META
 * (label / control / group) and rendered with `renderControl`. Shared
 * asr_defaults fields are managed globally (CustomConfigModal), so they do
 * not appear here.
 */

import {
  ChartNoAxesCombined,
  ChevronsUp,
  CircleCheck,
  CloudDownload,
  Cog,
  LoaderCircle,
  RotateCcw,
  Trash,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ModelDownloadProgress } from "@/settings/bridge";
import { Badge } from "@/settings/components/Badge";
import { Button } from "@/settings/components/Button";
import { Input } from "@/settings/components/Input";
import { SegmentedControl } from "@/settings/components/SegmentedControl";
import { Textarea } from "@/settings/components/Textarea";
import { Toggle } from "@/settings/components/Toggle";
import {
  Section,
  SectionContent,
  SectionHeader,
  SectionItem,
  SectionItemList,
} from "@/settings/layout/PageLayout";
import {
  type AsrDefaults,
  type ControlType,
  credentialHelpUrl,
  DOUBAO_MODEL_ID,
  effectiveDoubaoAuthMode,
  type FieldMeta,
  getFieldMeta,
  getMergedAsrConfig,
  hasLegacyDoubaoCreds,
  isModelFieldVisible,
  type MergedField,
  parseLanguageList,
  resolveFieldMeta,
} from "@/settings/lib/model";
import type { RegistryModel } from "@/settings/types/models";

const CAPABILITY_LABELS: Record<string, string> = {
  streaming: "ui.model.capability.streaming",
  hotwords: "ui.model.capability.hotwords",
  punctuation: "ui.model.capability.punctuation",
  itn: "ui.model.capability.itn",
};

/** Build a nested patch from a flattened key (e.g. "corpus.x" → { corpus: { x } }). */
function patchFromFlatKey(flatKey: string, value: unknown): Record<string, unknown> {
  const idx = flatKey.indexOf(".");
  if (idx === -1) return { [flatKey]: value };
  const parent = flatKey.slice(0, idx);
  const child = flatKey.slice(idx + 1);
  return { [parent]: { [child]: value } };
}

/** Trim f32→f64 round-trip artifacts (e.g. 0.20000000298023224) for display. */
function formatNumber(value: number): string {
  return String(Number(value.toPrecision(6)));
}

/** Render the control matching a field's metadata. */
export function renderControl(
  meta: FieldMeta,
  value: unknown,
  onChange: (value: unknown) => void,
): ReactNode {
  const type: ControlType = meta.type ?? "text";
  switch (type) {
    case "toggle":
      return <Toggle checked={!!value} onChange={onChange} />;
    case "number": {
      const step = meta.step ?? (Number.isInteger(value) ? 1 : 0.1);
      return (
        <Input
          type="number"
          step={step}
          min={meta.min}
          max={meta.max}
          className="w-36"
          value={typeof value === "number" ? formatNumber(value) : ""}
          onChange={(v) => {
            const n = Number(v);
            if (
              v.trim() &&
              Number.isFinite(n) &&
              (meta.min === undefined || n >= meta.min) &&
              (meta.max === undefined || n <= meta.max) &&
              (step !== 1 || Number.isInteger(n))
            )
              onChange(n);
          }}
          onBlur={(e) => {
            if (!e.currentTarget.validity.valid) e.currentTarget.reportValidity();
          }}
          commitOnBlur
        />
      );
    }
    case "segment":
      return (
        <SegmentedControl
          options={meta.options ?? []}
          value={String(value ?? "")}
          onChange={onChange}
        />
      );
    case "list":
      return (
        <Input
          value={Array.isArray(value) ? value.join(", ") : ""}
          placeholder={meta.placeholder}
          onChange={(v) => onChange(parseLanguageList(v))}
          commitOnBlur
          className="w-full"
        />
      );
    case "textarea":
      return (
        <Textarea
          value={String(value ?? "")}
          onChange={onChange}
          className="w-full"
          textareaClassName="min-h-20"
          maxLength={meta.maxLength}
          placeholder={meta.placeholder}
          commitOnBlur
        />
      );
    default:
      return (
        <Input
          type={type}
          className="w-full"
          value={String(value ?? "")}
          onChange={onChange}
          placeholder={meta.placeholder}
          commitOnBlur
        />
      );
  }
}

export interface ModelCardProps {
  model: RegistryModel;
  isActive: boolean;
  isDownloaded: boolean;
  userConfig: Record<string, unknown> | undefined;
  asrDefaults?: AsrDefaults | null;
  downloadProgress?: ModelDownloadProgress;
  onToggleActive: (modelId: string, active: boolean) => void;
  onDownload: (modelId: string) => void;
  onDelete: (modelId: string) => void;
  onConfigChange: (modelId: string, patch: Record<string, unknown>) => void;
  onResetConfig: (modelId: string) => void;
}

export function ModelCard({
  model,
  isActive,
  isDownloaded,
  userConfig,
  asrDefaults,
  downloadProgress,
  onToggleActive,
  onDownload,
  onDelete,
  onConfigChange,
  onResetConfig,
}: ModelCardProps) {
  const { t } = useTranslation();
  const [configExpanded, setConfigExpanded] = useState(false);
  const [advancedExpanded, setAdvancedExpanded] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);

  const isOnline = model.type === "online";
  const isBase = model.category === "vad" || model.category === "punctuation";
  const showConfig = !isBase;

  const fields = useMemo(
    () => getMergedAsrConfig(model, userConfig, asrDefaults),
    [model, userConfig, asrDefaults],
  );
  const fieldMeta = (f: MergedField) => getFieldMeta(f.key, f.value, model.id);
  const effectiveConfig = Object.fromEntries(fields.map((f) => [f.key, f.value]));

  // Doubao auth-mode aware visibility: which credentials show depends on the
  // active mode (legacy App ID/Token vs v2 API Key), and the mode toggle is only
  // offered to users who already have legacy creds saved. New users see only the
  // API Key, so they aren't confronted with a mode switch they don't need.
  const isDoubao = model.id === DOUBAO_MODEL_ID;
  const doubaoMode = isDoubao ? effectiveDoubaoAuthMode(userConfig) : null;
  const doubaoHasLegacy = isDoubao && hasLegacyDoubaoCreds(userConfig);

  const visibleFields = fields.filter((f) => {
    const meta = fieldMeta(f);
    if (!isModelFieldVisible(model.id, f.key, effectiveConfig)) return false;
    if (meta.group === "advanced") return false;
    if (isDoubao && doubaoMode) {
      if (f.key === "auth_mode") return doubaoHasLegacy;
      if (f.key === "app_id" || f.key === "access_token") return doubaoMode === "legacy";
      if (f.key === "api_key") return doubaoMode === "v2";
    }
    return true;
  });
  const advancedFields = fields.filter(
    (f) =>
      fieldMeta(f).group === "advanced" && isModelFieldVisible(model.id, f.key, effectiveConfig),
  );
  const hasConfig = visibleFields.length > 0 || advancedFields.length > 0;

  const isDownloading = downloadProgress?.status === "downloading";
  const isFailed = downloadProgress?.status === "failed";
  const progress =
    typeof downloadProgress?.progress === "number"
      ? Math.max(0, Math.min(100, Math.round(downloadProgress.progress)))
      : undefined;

  const memStr = model.mem_size ? `${model.mem_size}MB` : "";
  const fileStr = model.file_size ? `${model.file_size}MB` : "";

  const renderHeaderAction = () => {
    if (isOnline) {
      // Online (cloud) models are always available: help link + activation toggle.
      return (
        <div className="flex items-center gap-3">
          <a
            className="text-xs text-accent hover:underline"
            href={credentialHelpUrl(model.id)}
            target="_blank"
            rel="noreferrer"
          >
            {t("ui.model.how_to_get_credentials")}
          </a>
          <Toggle checked={isActive} onChange={(v) => onToggleActive(model.id, v)} />
        </div>
      );
    }
    return (
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
            <Button size="icon" onClick={() => onDelete(model.id)}>
              <Trash size={16} />
            </Button>
            {!isBase && <Toggle checked={isActive} onChange={(v) => onToggleActive(model.id, v)} />}
          </>
        ) : (
          <div className="flex items-center gap-2">
            {fileStr && (
              <span className="text-xs text-text-muted">
                {t("ui.model.model_file", { size: fileStr })}
              </span>
            )}
            <Button size="icon" onClick={() => onDownload(model.id)} disabled={isDownloading}>
              {isDownloading ? (
                <LoaderCircle size={16} className="animate-spin" />
              ) : isFailed ? (
                <RotateCcw size={16} />
              ) : (
                <CloudDownload size={16} />
              )}
            </Button>
          </div>
        )}
      </div>
    );
  };

  const renderField = (field: MergedField) => {
    const meta = resolveFieldMeta(fieldMeta(field), t);
    const control = renderControl(meta, field.value, (value) => {
      setConfigError(null);
      Promise.resolve(onConfigChange(model.id, patchFromFlatKey(field.key, value))).catch((error) =>
        setConfigError(error instanceof Error ? error.message : String(error)),
      );
    });
    const fullWidth = field.key === "transcript_edit";
    return (
      <SectionItem
        key={field.key}
        title={meta.label}
        description={meta.description}
        tooltip={meta.tooltip}
        action={fullWidth ? undefined : control}
      >
        {fullWidth ? control : undefined}
      </SectionItem>
    );
  };

  return (
    <Section>
      <SectionHeader
        title={model.name}
        subtitle={model.description}
        action={renderHeaderAction()}
      />
      <SectionContent>
        {model.capabilities && (
          <div className="flex items-center gap-2 flex-wrap">
            {Object.entries(CAPABILITY_LABELS).map(([key, label]) => (
              <Badge key={key} variant="ghost">
                <CircleCheck
                  size={16}
                  className={`text-surface ${model.capabilities?.[key] ? "fill-success" : "fill-text-muted"}`}
                />
                <span>{t(label)}</span>
              </Badge>
            ))}
          </div>
        )}

        {/* Meta row: tags + capabilities + config toggle */}
        <div className="flex flex-wrap items-center gap-2">
          {model.tags?.map((tag) => (
            <Badge key={tag} variant="accent">
              {tag}
            </Badge>
          ))}
          {memStr && model.category === "asr" && (
            <div className="flex gap-1 items-center text-text-muted">
              <ChartNoAxesCombined size={16} />
              <span className="text-sm">{t("ui.model.memory_peak", { size: memStr })}</span>
            </div>
          )}

          {showConfig && hasConfig && (
            <span className="ml-auto">
              <Button variant="ghost" onClick={() => setConfigExpanded((v) => !v)}>
                <Cog size={16} />
                {t("ui.model.config")}
              </Button>
            </span>
          )}
        </div>

        {/* Expandable config panel */}
        {showConfig && configExpanded && hasConfig && (
          <div className="border-t border-border-subtle pt-4 space-y-4">
            {configError && (
              <p role="alert" className="text-error text-sm">
                {configError}
              </p>
            )}
            <SectionItemList>{visibleFields.map(renderField)}</SectionItemList>

            {advancedFields.length > 0 && (
              <div className="space-y-2">
                {advancedExpanded && (
                  <SectionItemList>{advancedFields.map(renderField)}</SectionItemList>
                )}
              </div>
            )}

            <div className="flex justify-between">
              <Button variant="ghost" onClick={() => onResetConfig(model.id)}>
                <RotateCcw size={16} />
                {t("ui.model.reset")}
              </Button>

              {advancedFields.length > 0 && (
                <Button
                  className="ml-auto"
                  variant="ghost"
                  onClick={() => setAdvancedExpanded((v) => !v)}
                >
                  <ChevronsUp
                    size={16}
                    className={`transition-transform duration-300 ${advancedExpanded ? "rotate-0" : "rotate-180"}`}
                  />
                  {t("ui.model.more_params")}
                </Button>
              )}
            </div>
          </div>
        )}
      </SectionContent>
    </Section>
  );
}
