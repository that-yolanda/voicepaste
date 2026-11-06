/**
 * Right-side model configuration drawers.
 *
 * - AsrModelConfigDrawer: FIELD_META-driven fields (common directly visible,
 *   advanced collapsed), matching the previous ModelCard expand panel minus
 *   credential fields (those live in the provider credential card).
 * - LlmModelConfigDrawer: model id / display name + inference params
 *   (temperature / max_tokens / top_p, only user-set values are sent).
 *
 * Footer follows the design: 移除模型 (left) · 恢复默认 · 完成.
 */

import { ChevronsUp, RotateCcw, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/settings/components/Button";
import { Drawer } from "@/settings/components/Drawer";
import { Input } from "@/settings/components/Input";
import { renderControl } from "@/settings/components/models/FieldControl";
import { SectionItem, SectionItemList } from "@/settings/layout/PageLayout";
import { DOUBAO_LANGUAGE_CODES, languageName } from "@/settings/lib/languages";
import {
  type AsrDefaults,
  DOUBAO_MODEL_ID,
  getFieldMeta,
  getMergedAsrConfig,
  isModelFieldVisible,
  localizedModelFields,
  type MergedField,
  resolveFieldMeta,
} from "@/settings/lib/model";
import type { LlmModelEntry, LlmModelParams, RegistryModel } from "@/settings/types/models";

/** Build a nested patch from a flattened key (e.g. "corpus.x" → { corpus: { x } }). */
function patchFromFlatKey(flatKey: string, value: unknown): Record<string, unknown> {
  const idx = flatKey.indexOf(".");
  if (idx === -1) return { [flatKey]: value };
  const parent = flatKey.slice(0, idx);
  const child = flatKey.slice(idx + 1);
  return { [parent]: { [child]: value } };
}

/* ======================================================================
   ASR drawer
   ====================================================================== */

interface AsrModelConfigDrawerProps {
  model: RegistryModel;
  onClose: () => void;
  userConfig: Record<string, unknown> | undefined;
  asrDefaults: AsrDefaults | null;
  onConfigChange: (modelId: string, patch: Record<string, unknown>) => void;
  onReset: (modelId: string) => void;
  /** Preset removal (positive list) or file deletion for local models. */
  onRemove: (model: RegistryModel) => void;
  removeLabel: string;
}

export function AsrModelConfigDrawer({
  model,
  onClose,
  userConfig,
  asrDefaults,
  onConfigChange,
  onReset,
  onRemove,
  removeLabel,
}: AsrModelConfigDrawerProps) {
  const { t, i18n } = useTranslation();
  const [advancedExpanded, setAdvancedExpanded] = useState(false);
  const { name, description } = localizedModelFields(model, i18n.language);
  const isVad = model.category === "vad";

  const fields = useMemo(() => {
    if (isVad) {
      return Object.entries(asrDefaults?.vad ?? model.default_config ?? {}).map(([key, value]) => ({
        key: `vad.${key}`,
        value,
      }));
    }
    return getMergedAsrConfig(model, userConfig, asrDefaults);
  }, [model, userConfig, asrDefaults, isVad]);
  const fieldMeta = (f: MergedField) => getFieldMeta(f.key, f.value, model.id);
  const effectiveConfig = Object.fromEntries(fields.map((f) => [f.key, f.value]));

  const visible = fields.filter((f) => {
    const meta = fieldMeta(f);
    if (meta.group === "credentials" || meta.group === "advanced") return false;
    return isModelFieldVisible(model.id, f.key, effectiveConfig);
  });
  const advanced = fields.filter(
    (f) =>
      fieldMeta(f).group === "advanced" && isModelFieldVisible(model.id, f.key, effectiveConfig),
  );
  // VAD model rows surface the shared VAD params (they write asr_defaults.vad).
  const vadFields = isVad
    ? fields.filter((f) => f.key.startsWith("vad.") && fieldMeta(f).group !== "credentials")
    : [];
  const shown = isVad ? vadFields : visible;

  const renderField = (field: MergedField) => {
    const meta = resolveFieldMeta(fieldMeta(field), t);
    if (model.id === DOUBAO_MODEL_ID && field.key === "language") {
      meta.options = [
        { value: "", label: t("field.doubao.language.default") },
        ...Object.entries(DOUBAO_LANGUAGE_CODES).map(([code, value]) => ({
          value,
          label: languageName(code, i18n.language),
        })),
      ];
    }
    if (model.id === DOUBAO_MODEL_ID && field.key === "resource_id") {
      meta.options = meta.options?.map((option) => ({
        ...option,
        label: `${option.label} (${option.value})`,
      }));
    }
    const control = renderControl(meta, field.value, (value) =>
      onConfigChange(model.id, patchFromFlatKey(field.key, value)),
    );
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
    <Drawer
      open
      onClose={onClose}
      title={t("ui.models.model_config")}
      subtitle={`${description || name}`}
      footer={
        <>
          <Button variant="ghost" className="mr-auto" onClick={() => onRemove(model)}>
            <Trash2 size={15} />
            {removeLabel}
          </Button>
          <Button variant="ghost" onClick={() => onReset(model.id)}>
            <RotateCcw size={15} />
            {t("ui.model.reset")}
          </Button>
          <Button variant="accent" onClick={onClose}>
            {t("ui.models.done")}
          </Button>
        </>
      }
    >
      {shown.length > 0 ? (
        <SectionItemList>{shown.map(renderField)}</SectionItemList>
      ) : (
        <p className="text-sm text-text-muted">{t("ui.models.no_config_fields")}</p>
      )}
      {!isVad && advanced.length > 0 && (
        <div className="mt-4 space-y-2">
          {advancedExpanded && <SectionItemList>{advanced.map(renderField)}</SectionItemList>}
          <Button variant="ghost" className="w-full" onClick={() => setAdvancedExpanded((v) => !v)}>
            <ChevronsUp
              size={15}
              className={`transition-transform duration-300 ${advancedExpanded ? "rotate-0" : "rotate-180"}`}
            />
            {t("ui.model.more_params")}
          </Button>
        </div>
      )}
    </Drawer>
  );
}

/* ======================================================================
   LLM drawer
   ====================================================================== */

const PARAM_FIELDS: {
  key: keyof LlmModelParams;
  label: string;
  min: number;
  max: number;
  step: number;
  placeholder: string;
}[] = [
  {
    key: "temperature",
    label: "ui.models.param_temperature",
    min: 0,
    max: 2,
    step: 0.1,
    placeholder: "0.3",
  },
  {
    key: "max_tokens",
    label: "ui.models.param_max_tokens",
    min: 1,
    max: 32768,
    step: 1,
    placeholder: "4096",
  },
  { key: "top_p", label: "ui.models.param_top_p", min: 0, max: 1, step: 0.05, placeholder: "—" },
];

interface LlmModelConfigDrawerProps {
  /** Current entry values (id / name / model_id override / params). */
  entry: LlmModelEntry;
  /** Registry preset display name, when this entry references one. */
  presetName?: string;
  /** Request string used when no override is set (preset default or id). */
  requestDefault: string;
  isCustom: boolean;
  onClose: () => void;
  onChange: (entry: LlmModelEntry) => void;
  onRemove: () => void;
}

export function LlmModelConfigDrawer({
  entry,
  presetName,
  requestDefault,
  isCustom,
  onClose,
  onChange,
  onRemove,
}: LlmModelConfigDrawerProps) {
  const { t } = useTranslation();
  const [advancedExpanded, setAdvancedExpanded] = useState(false);
  const displayName = entry.name ?? presetName ?? entry.id;

  const setParams = (key: keyof LlmModelParams, raw: string) => {
    const trimmed = raw.trim();
    const next: LlmModelParams = { ...entry.params };
    if (!trimmed) delete next[key];
    else {
      const n = Number(trimmed);
      const field = PARAM_FIELDS.find((f) => f.key === key);
      if (!field || !Number.isFinite(n) || n < field.min || n > field.max) return;
      next[key] = n;
    }
    onChange({ ...entry, params: Object.keys(next).length > 0 ? next : undefined });
  };

  return (
    <Drawer
      open
      onClose={onClose}
      title={t("ui.models.model_config")}
      subtitle={displayName}
      footer={
        <>
          <Button variant="ghost" className="mr-auto" onClick={onRemove}>
            <Trash2 size={15} />
            {t("ui.models.remove_model")}
          </Button>
          <Button
            variant="ghost"
            onClick={() => onChange({ ...entry, model_id: undefined, params: undefined })}
          >
            <RotateCcw size={15} />
            {t("ui.model.reset")}
          </Button>
          <Button variant="accent" onClick={onClose}>
            {t("ui.models.done")}
          </Button>
        </>
      }
    >
      <SectionItemList>
        <SectionItem
          title={t("ui.models.model_name")}
          action={
            isCustom ? (
              <Input
                className="w-full"
                value={entry.name ?? ""}
                placeholder={entry.id}
                onChange={(v) => onChange({ ...entry, name: v.trim() || undefined })}
                commitOnBlur
              />
            ) : (
              <span className="text-sm text-text">{presetName ?? entry.id}</span>
            )
          }
        />
        <SectionItem
          title={t("ui.models.model_id")}
          action={
            <Input
              className="w-full"
              value={entry.model_id ?? ""}
              placeholder={requestDefault}
              onChange={(v) => onChange({ ...entry, model_id: v.trim() || undefined })}
              commitOnBlur
            />
          }
          description={t("ui.models.model_id_description")}
        />
      </SectionItemList>

      <div className="mt-4 space-y-2">
        {advancedExpanded && (
          <SectionItemList>
            {PARAM_FIELDS.map((field) => (
              <SectionItem
                key={field.key}
                title={t(field.label)}
                tooltip={t(`${field.label}.tooltip`)}
                action={
                  <Input
                    type="number"
                    className="w-36"
                    min={field.min}
                    max={field.max}
                    step={field.step}
                    placeholder={field.placeholder}
                    value={entry.params?.[field.key] ?? ""}
                    onChange={(v) => setParams(field.key, v)}
                    commitOnBlur
                  />
                }
              />
            ))}
          </SectionItemList>
        )}
        <Button variant="ghost" className="w-full" onClick={() => setAdvancedExpanded((v) => !v)}>
          <ChevronsUp
            size={15}
            className={`transition-transform duration-300 ${advancedExpanded ? "rotate-0" : "rotate-180"}`}
          />
          {t("ui.models.inference_params")}
        </Button>
        <p className="text-center text-xs text-text-muted">
          {t("ui.models.inference_params_hint")}
        </p>
      </div>
    </Drawer>
  );
}

export { patchFromFlatKey };
