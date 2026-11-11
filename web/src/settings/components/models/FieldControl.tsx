/**
 * Data-driven field control rendering: maps a FIELD_META entry to the right
 * wrapped control (toggle / number / select / segment / list / textarea /
 * text). Extracted from the old ModelCard so both the credential card and
 * the model config modal share one rendering path.
 */

import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/settings/components/Input";
import { SegmentedControl } from "@/settings/components/SegmentedControl";
import { Select } from "@/settings/components/Select";
import { Textarea } from "@/settings/components/Textarea";
import { Toggle } from "@/settings/components/Toggle";
import {
  type ControlType,
  type FieldMeta,
  parseLanguageList,
  validateLanguageList,
} from "@/settings/lib/model";

/** Trim f32→f64 round-trip artifacts (e.g. 0.20000000298023224) for display. */
function formatNumber(value: number): string {
  return String(Number(value.toPrecision(6)));
}

function LanguageListControl({
  meta,
  value,
  onChange,
}: {
  meta: FieldMeta;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <Input
        aria-label={meta.label}
        aria-invalid={!!error}
        value={Array.isArray(value) ? value.join(", ") : ""}
        placeholder={meta.placeholder}
        onInput={(event) => {
          const error = validateLanguageList(parseLanguageList(event.currentTarget.value));
          event.currentTarget.setCustomValidity(error ? t(error) : "");
          setError(error);
        }}
        onChange={(text) => {
          const codes = parseLanguageList(text);
          const error = validateLanguageList(codes);
          setError(error);
          if (!error) onChange(codes);
        }}
        onBlur={(event) => {
          if (!event.currentTarget.validity.valid) event.currentTarget.reportValidity();
        }}
        commitOnBlur
        className="w-full"
      />
      {error && (
        <p role="alert" className="mt-1 text-xs text-error">
          {t(error)}
        </p>
      )}
    </div>
  );
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
          className="w-full"
          value={typeof value === "number" ? formatNumber(value) : ""}
          placeholder={meta.placeholder}
          onChange={(v) => {
            if (meta.nullable && !v.trim()) {
              onChange(null);
              return;
            }
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
    case "select": {
      const current = String(value ?? "");
      const options = meta.options ?? [];
      return (
        <Select
          aria-label={meta.label}
          value={current}
          onChange={onChange}
          options={
            options.some((option) => option.value === current)
              ? options
              : [...options, { value: current, label: current }]
          }
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
      return <LanguageListControl meta={meta} value={value} onChange={onChange} />;
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
