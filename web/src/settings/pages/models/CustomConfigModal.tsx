/**
 * Shared ASR defaults modal (asr_defaults: 采样 / 识别增强 / 离线参数).
 * Moved verbatim from the old AudioModelPage — the entry button now lives in
 * the model services filter row.
 */

import { useTranslation } from "react-i18next";
import { Modal } from "@/settings/components/Modal";
import { renderControl } from "@/settings/components/models/FieldControl";
import {
  Section,
  SectionContent,
  SectionHeader,
  SectionItem,
  SectionItemList,
} from "@/settings/layout/PageLayout";
import {
  type AsrDefaults,
  getFieldMeta,
  mergeAsrDefaults,
  resolveFieldMeta,
} from "@/settings/lib/model";

const ASR_DEFAULTS_ID = "asr_defaults";

/** asr_defaults fields shown in the CustomConfigModal, grouped by section. */
const ASR_DEFAULT_SECTIONS: { title: string; fields: string[] }[] = [
  { title: "ui.audio.section_sample", fields: ["rate", "channel"] },
  {
    title: "ui.audio.section_enhance",
    fields: ["stream_simulate", "hotword_llm_mode", "hotword_replace"],
  },
  {
    title: "ui.audio.section_offline",
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

interface CustomConfigModalProps {
  open: boolean;
  onClose: () => void;
  asrDefaults: AsrDefaults | null;
  saveAsrDefaults: (updates: Record<string, unknown>) => Promise<void>;
  saveAsrVadDefaults: (updates: Record<string, unknown>) => Promise<void>;
}

export function CustomConfigModal({
  open,
  onClose,
  asrDefaults,
  saveAsrDefaults,
  saveAsrVadDefaults,
}: CustomConfigModalProps) {
  const { t } = useTranslation();
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
      void saveAsrVadDefaults({ [flatKey.slice(4)]: value });
    } else {
      void saveAsrDefaults({ [flatKey]: value });
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={t("ui.audio.custom_config")}>
      <div className="space-y-5">
        {ASR_DEFAULT_SECTIONS.map((section) => (
          <Section key={section.title}>
            <SectionHeader title={t(section.title)} />
            <SectionContent>
              <SectionItemList>
                {section.fields.map((flatKey) => {
                  const value = getValue(flatKey);
                  const meta = resolveFieldMeta(getFieldMeta(flatKey, value), t);
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
}

/** Merge runtime backend defaults with the user-saved audio.asr_defaults. */
export function mergeRuntimeAsrDefaults(
  runtimeDefaults: AsrDefaults | null,
  audio: Record<string, unknown>,
): AsrDefaults | null {
  return runtimeDefaults ? mergeAsrDefaults(runtimeDefaults, audio[ASR_DEFAULTS_ID]) : null;
}

export { ASR_DEFAULTS_ID, isRecord };
