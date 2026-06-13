import { useCallback, useEffect, useRef, useState } from "react";
import { loadPrompts, savePrompts } from "@/bridge/settings";
import { Button } from "@/ui/components/Button";
import { Input } from "@/ui/components/Input";
import {
  PageHeader,
  PageLayout,
  Section,
  SectionContent,
  SectionHeader,
  SectionItemList,
  SectionItem
} from "@/ui/layout/PageLayout";
import { useSettings } from "@/ui/SettingsProvider";
import { Trash } from "lucide-react"

const LLM_PROVIDERS = [
  {
    key: "deepseek",
    label: "DeepSeek",
    url: "https://api.deepseek.com",
    model: "deepseek-chat",
    baseUrlPlaceholder: "DeepSeek 无需配置，默认即可使用",
    modelHint: "如 deepseek-chat",
  },
  {
    key: "openai",
    label: "OpenAI",
    url: "https://api.openai.com/v1",
    model: "gpt-4o",
    baseUrlPlaceholder: "OpenAI 无需配置，默认即可使用",
    modelHint: "如 gpt-4o-mini, gpt-4o",
  },
  {
    key: "openrouter",
    label: "OpenRouter",
    url: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4o",
    baseUrlPlaceholder: "OpenRouter 无需配置，默认即可使用",
    modelHint: "如 openai/gpt-4o",
  },
  {
    key: "siliconflow",
    label: "硅基流动",
    url: "https://api.siliconflow.cn/v1",
    model: "Qwen/Qwen2.5-7B-Instruct",
    baseUrlPlaceholder: "硅基流动无需配置，默认即可使用",
    modelHint: "如 Qwen/Qwen2.5-7B-Instruct",
  },
  {
    key: "gemini",
    label: "Gemini",
    url: "https://generativelanguage.googleapis.com/v1beta",
    model: "gemini-pro",
    baseUrlPlaceholder: "Gemini 无需配置，默认即可使用",
    modelHint: "如 gemini-pro",
  },
  {
    key: "anthropic",
    label: "Anthropic",
    url: "https://api.anthropic.com/v1",
    model: "claude-3-5-sonnet-20241022",
    baseUrlPlaceholder: "Anthropic 无需配置，默认即可使用",
    modelHint: "如 claude-3-5-sonnet-20241022",
  },
  {
    key: "ollama",
    label: "Ollama 本地",
    url: "http://localhost:11434",
    model: "llama3.2",
    baseUrlPlaceholder: "请填写 Ollama 地址",
    modelHint: "如 llama3.2, qwen2.5",
  },
  {
    key: "openai_compatible",
    label: "自定义",
    url: "",
    model: "",
    baseUrlPlaceholder: "请填写自定义 API 地址",
    modelHint: "填写模型名称",
  },
];

interface PromptItem {
  id: string;
  title: string;
  hotkey?: string[];
  hotkey_mode?: string;
  prompt?: string;
  _displayString?: string;
}

let promptIdCounter = 1;
function createPromptId(): string {
  return `p_${Date.now()}_${promptIdCounter++}`;
}

export function LLMPage() {
  const { settings, scheduleSave } = useSettings();
  const cfg = settings?.parsedConfig || ({} as Record<string, unknown>);
  const llm = (cfg.llm || {}) as Record<string, unknown>;

  const providerKey = (llm.provider as string) || "deepseek";
  const currentP = LLM_PROVIDERS.find((p) => p.key === providerKey) || LLM_PROVIDERS[0];
  const savedProviderCfg = (llm[providerKey] || {}) as Record<string, string>;

  const [prompts, setPrompts] = useState<PromptItem[]>([]);
  const promptsSaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Load prompts
  const loadP = useCallback(async () => {
    try {
      const data = (await loadPrompts()) as unknown as PromptItem[];
      if (Array.isArray(data)) setPrompts(data);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    loadP();
  }, [loadP]);

  const scheduleSavePrompts = useCallback((items: PromptItem[]) => {
    if (promptsSaveTimer.current) clearTimeout(promptsSaveTimer.current);
    promptsSaveTimer.current = setTimeout(() => {
      savePrompts(items as unknown[]).catch(() => {});
    }, 500);
  }, []);

  const savePromptsNow = useCallback(async (items: PromptItem[]) => {
    if (promptsSaveTimer.current) {
      clearTimeout(promptsSaveTimer.current);
      promptsSaveTimer.current = undefined;
    }
    await savePrompts(items as unknown[]);
  }, []);

  // LLM provider switch
  const switchProvider = useCallback(
    (key: string) => {
      const p = LLM_PROVIDERS.find((x) => x.key === key) || LLM_PROVIDERS[0];
      const llmUpdates: Record<string, unknown> = {
        provider: key,
        [key]: {
          ...(savedProviderCfg || {}),
          url: savedProviderCfg.url || p.url,
          model: savedProviderCfg.model || p.model,
        },
      };
      scheduleSave({ llm: { ...llm, ...llmUpdates } });
    },
    [llm, savedProviderCfg, scheduleSave],
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
      <PageHeader title="文本润色" description="用于语音识别后的文本润色与文本结构化"/>
      {/* Provider grid */}
      <Section>
        <SectionHeader title="模型厂商" />
        <SectionContent>
          <div className="flex flex-wrap gap-2">
            {LLM_PROVIDERS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => switchProvider(p.key)}
                className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                  providerKey === p.key
                    ? "bg-accent text-text-on-accent"
                    : "bg-fill-interactive text-text-dim hover:bg-fill-hover"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </SectionContent>
      </Section>

      {/* API Config */}
      <Section>
        <SectionHeader title="API 配置" />
        <SectionContent>
          <div className="space-y-4">
            <div>
              <p className="text-sm text-text-dim mb-1.5">API 地址</p>
              <p className="text-xs text-text-muted mb-2">{currentP.baseUrlPlaceholder}</p>
              <Input
                className="w-full"
                placeholder="https://api.example.com/v1"
                value={savedProviderCfg.url || ""}
                onChange={(v) => setLlmField("url", v)}
              />
            </div>
            <div>
              <p className="text-sm text-text-dim mb-1.5">API Key</p>
              <Input
                className="w-full"
                type="password"
                placeholder="sk-..."
                value={savedProviderCfg.api_key || ""}
                onChange={(v) => setLlmField("api_key", v)}
              />
            </div>
            <div>
              <p className="text-sm text-text-dim mb-1.5">模型名称</p>
              <p className="text-xs text-text-muted mb-2">{currentP.modelHint}</p>
              <Input
                className="w-full"
                placeholder={currentP.model}
                value={savedProviderCfg.model || ""}
                onChange={(v) => setLlmField("model", v)}
              />
            </div>
          </div>
        </SectionContent>
      </Section>

      {/* Prompts */}
      <Section>
        <SectionHeader
          title="润色模板"
          subtitle="编辑文本润色模板内容；模板快捷键在「快捷键」页面配置"
          action={
            <Button
              size="sm"
              variant="accent"
              onClick={async () => {
                const updated = [
                  ...prompts,
                  {
                    id: createPromptId(),
                    title: "新建模板",
                    hotkey: [],
                    hotkey_mode: "toggle",
                    prompt: "",
                  },
                ];
                setPrompts(updated);
                await savePromptsNow(updated);
              }}
            >
              + 添加模板
            </Button>
          }
        />
        <SectionContent>
          <SectionItemList >
            {prompts.map((item, index) => (
              <SectionItem key={item.id} className="flex flex-col">
                <div className="flex items-center gap-2 w-full">
                  <input
                    type="text"
                    value={item.title || ""}
                    onChange={(e) => {
                      const updated = [...prompts];
                      updated[index] = { ...updated[index], title: e.target.value };
                      setPrompts(updated);
                      scheduleSavePrompts(updated);
                    }}
                    className="flex-1 h-[34px] px-3 rounded-lg bg-input-bg border border-border text-text text-sm focus:outline-none focus:ring-1 focus:ring-accent-dim"
                    placeholder="模板名称"
                  />
                  <Button
                    size="sm"
                    onClick={async () => {
                      const updated = prompts.filter((_, j) => j !== index);
                      setPrompts(updated);
                      await savePromptsNow(updated);
                    }}
                  >
                    <Trash size={16}/>
                  </Button>
                </div>
                <textarea
                  value={item.prompt || ""}
                  onChange={(e) => {
                    const updated = [...prompts];
                    updated[index] = { ...updated[index], prompt: e.target.value };
                    setPrompts(updated);
                    scheduleSavePrompts(updated);
                  }}
                  className="w-full h-32 px-3 py-2 rounded-lg bg-input-bg border border-border text-text text-sm resize-none focus:outline-none focus:ring-1 focus:ring-accent-dim"
                  placeholder="输入系统提示词…"
                />
              </SectionItem>
            ))}
          </SectionItemList>
        </SectionContent>
      </Section>
    </PageLayout>
  );
}
