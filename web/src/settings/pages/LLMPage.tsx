import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/settings/components/Input";
import { Select } from "@/settings/components/Select";
import {
  PageLayout,
  Section,
  SectionContent,
  SectionItem,
  SectionItemList,
} from "@/settings/layout/PageLayout";
import { useSettings } from "@/settings/SettingsProvider";

// Defaults MUST mirror Rust `get_provider_defaults` (src-tauri/src/llm.rs):
// when a field is left empty the backend fills it from that table, so the
// values shown in the UI have to match what the backend actually requests.
const LLM_PROVIDERS = [
  {
    key: "deepseek",
    label: "ui.llm.provider.deepseek",
    url: "https://api.deepseek.com/v1/chat/completions",
    model: "deepseek-flash",
  },
  {
    key: "openai",
    label: "ui.llm.provider.openai",
    url: "https://api.openai.com/v1/chat/completions",
    model: "gpt-6-luna",
  },
  {
    key: "openrouter",
    label: "ui.llm.provider.openrouter",
    url: "https://openrouter.ai/api/v1/chat/completions",
    model: "openai/gpt-6-luna",
  },
  {
    key: "siliconflow",
    label: "ui.llm.provider.siliconflow",
    url: "https://api.siliconflow.cn/v1/chat/completions",
    model: "Qwen/Qwen3.5-4B",
  },
  {
    key: "gemini",
    label: "ui.llm.provider.gemini",
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    model: "gemini-3.5-flash-lite",
  },
  {
    key: "anthropic",
    label: "ui.llm.provider.anthropic",
    url: "https://api.anthropic.com/v1/chat/completions",
    model: "claude-haiku-5-5",
  },
  {
    key: "ollama",
    label: "ui.llm.provider.ollama",
    url: "http://localhost:11434/v1/chat/completions",
    model: "qwen3.5:4b",
  },
  {
    key: "openai_compatible",
    label: "ui.llm.provider.custom",
    url: "",
    model: "",
  },
];

export function LLMPage() {
  const { t } = useTranslation();
  const { settings, scheduleSave } = useSettings();
  const cfg = settings?.parsedConfig || ({} as Record<string, unknown>);
  const llm = (cfg.llm || {}) as Record<string, unknown>;

  const providerKey = (llm.provider as string) || "deepseek";
  const currentP = LLM_PROVIDERS.find((p) => p.key === providerKey) || LLM_PROVIDERS[0];
  const savedProviderCfg = (llm[providerKey] || {}) as Record<string, string>;

  // LLM provider switch: just flip the active provider. URL/model are shown
  // via per-provider defaults at render time, so switching needs no data
  // writes — and we must NOT copy the current provider's values into the
  // target slot (that was the bug that made fields look unchanged).
  const switchProvider = useCallback(
    (key: string) => {
      scheduleSave({ llm: { ...llm, provider: key } });
    },
    [llm, scheduleSave],
  );

  // LLM field change
  const setLlmField = useCallback(
    (field: string, val: string) => {
      const providerCfg = (llm[providerKey] || {}) as Record<string, string>;
      scheduleSave({
        llm: {
          ...llm,
          [providerKey]: { ...providerCfg, [field]: val },
        },
      });
    },
    [llm, providerKey, scheduleSave],
  );

  return (
    <PageLayout>
      {/* API Config */}
      <Section data-tour="llm-config">
        <SectionContent>
          <SectionItemList>
            <SectionItem
              title={t("ui.llm.model")}
              htmlFor="llm-provider"
              action={
                <div data-tour="llm-provider" className="w-full">
                  <Select
                    id="llm-provider"
                    value={providerKey}
                    onChange={switchProvider}
                    options={LLM_PROVIDERS.map((p) => ({ value: p.key, label: t(p.label) }))}
                  />
                </div>
              }
            />

            <SectionItem
              title={t("ui.llm.url")}
              action={
                <Input
                  className="w-full"
                  value={savedProviderCfg.url || currentP.url}
                  onChange={(v) => setLlmField("url", v)}
                  commitOnBlur
                />
              }
            />

            <div data-tour="llm-api-key">
              <SectionItem
                title={t("ui.llm.api_key")}
                htmlFor="llm-api-key"
                action={
                  <Input
                    className="w-full"
                    id="llm-api-key"
                    type="password"
                    placeholder="sk-..."
                    value={savedProviderCfg.api_key || ""}
                    onChange={(v) => setLlmField("api_key", v)}
                    commitOnBlur
                  />
                }
              />
            </div>
            <SectionItem
              title={t("ui.llm.model_id")}
              action={
                <Input
                  className="w-full"
                  value={savedProviderCfg.model || currentP.model}
                  onChange={(v) => setLlmField("model", v)}
                  commitOnBlur
                />
              }
              last
            />
          </SectionItemList>
        </SectionContent>
      </Section>
    </PageLayout>
  );
}
