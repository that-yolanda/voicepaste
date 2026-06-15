import { Trash } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { loadPrompts, savePrompts } from "@/bridge/settings";
import { Button } from "@/ui/components/Button";
import { Input } from "@/ui/components/Input";
import { Textarea } from "@/ui/components/Textarea";
import {
  PageHeader,
  PageLayout,
  Section,
  SectionContent,
  SectionHeader,
  SectionItem,
  SectionItemList,
} from "@/ui/layout/PageLayout";
import { useSettings } from "@/ui/SettingsProvider";

const LLM_PROVIDERS = [
  {
    key: "deepseek",
    label: "DeepSeek",
    url: "https://api.deepseek.com",
    model: "deepseek-chat",
  },
  {
    key: "openai",
    label: "OpenAI",
    url: "https://api.openai.com/v1",
    model: "gpt-4o",
  },
  {
    key: "openrouter",
    label: "OpenRouter",
    url: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4o",
  },
  {
    key: "siliconflow",
    label: "硅基流动",
    url: "https://api.siliconflow.cn/v1",
    model: "Qwen/Qwen2.5-7B-Instruct",
  },
  {
    key: "gemini",
    label: "Gemini",
    url: "https://generativelanguage.googleapis.com/v1beta",
    model: "gemini-pro",
  },
  {
    key: "anthropic",
    label: "Anthropic",
    url: "https://api.anthropic.com/v1",
    model: "claude-3-5-sonnet-20241022",
  },
  {
    key: "ollama",
    label: "Ollama 本地",
    url: "http://localhost:11434",
    model: "llama3.2",
  },
  {
    key: "openai_compatible",
    label: "自定义",
    url: "",
    model: "",
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
      <PageHeader title="文本润色" description="用于语音识别后的文本润色与文本结构化" />
      {/* API Config */}
      <Section>
        <SectionHeader title="API 配置" />
        <SectionContent>
          <SectionItemList>
            <SectionItem title="模型">
              <div className="grid grid-cols-4 gap-2">
                {LLM_PROVIDERS.map((p) => (
                  <Button
                    key={p.key}
                    onClick={() => switchProvider(p.key)}
                    variant={providerKey === p.key ? "accent" : "ghost"}
                  >
                    {p.label}
                  </Button>
                ))}
              </div>
            </SectionItem>

            <SectionItem
              title="URL"
              action={
                <Input
                  className="w-full"
                  placeholder="留空使用默认地址"
                  value={savedProviderCfg.url || ""}
                  onChange={(v) => setLlmField("url", v)}
                />
              }
            />

            <SectionItem
              title="API Key"
              action={
                <Input
                  className="w-full"
                  type="password"
                  placeholder="sk-..."
                  value={savedProviderCfg.api_key || ""}
                  onChange={(v) => setLlmField("api_key", v)}
                />
              }
            />
            <SectionItem
              title="模型ID"
              action={
                <Input
                  className="w-full"
                  placeholder={currentP.model}
                  value={savedProviderCfg.model || ""}
                  onChange={(v) => setLlmField("model", v)}
                />
              }
              last
            />
          </SectionItemList>
        </SectionContent>
      </Section>

      {/* Prompts */}
      <Section>
        <SectionHeader
          title="润色模板"
          subtitle="编辑文本润色模板内容；模板快捷键在「快捷键」页面配置"
          action={
            <Button
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
          <SectionItemList>
            {prompts.map((item, index) => (
              <SectionItem
                key={item.id}
                title="模板名称"
                last={index === prompts.length - 1}
                action={
                  <div className="flex gap-2">
                    <Input
                      value={item.title || ""}
                      onChange={(value) => {
                        const updated = [...prompts];
                        updated[index] = { ...updated[index], title: value };
                        setPrompts(updated);
                        scheduleSavePrompts(updated);
                      }}
                      className="w-full"
                      placeholder="模板名称"
                    />
                    <Button
                      size="icon"
                      onClick={async () => {
                        const updated = prompts.filter((_, j) => j !== index);
                        setPrompts(updated);
                        await savePromptsNow(updated);
                      }}
                    >
                      <Trash size={16} />
                    </Button>
                  </div>
                }
              >
                <Textarea
                  value={item.prompt || ""}
                  onChange={(value) => {
                    const updated = [...prompts];
                    updated[index] = { ...updated[index], prompt: value };
                    setPrompts(updated);
                    scheduleSavePrompts(updated);
                  }}
                  textareaClassName="h-32 resize-none"
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
