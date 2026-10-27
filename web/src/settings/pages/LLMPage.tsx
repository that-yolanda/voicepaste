import { Trash } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { loadBuiltinPrompts, loadPrompts, savePrompts } from "@/settings/bridge";
import { Button } from "@/settings/components/Button";
import { Input } from "@/settings/components/Input";
import { Modal } from "@/settings/components/Modal";
import { Textarea } from "@/settings/components/Textarea";
import {
  PageHeader,
  PageLayout,
  Section,
  SectionContent,
  SectionHeader,
  SectionItem,
  SectionItemList,
} from "@/settings/layout/PageLayout";
import { cloneBuiltinPrompt } from "@/settings/lib/prompts";
import { useSettings } from "@/settings/SettingsProvider";
import type { PromptItem } from "@/settings/types/prompts";

// Defaults MUST mirror Rust `get_provider_defaults` (src-tauri/src/llm.rs):
// when a field is left empty the backend fills it from that table, so the
// values shown in the UI have to match what the backend actually requests.
const LLM_PROVIDERS = [
  {
    key: "deepseek",
    label: "DeepSeek",
    url: "https://api.deepseek.com/v1/chat/completions",
    model: "deepseek-flash",
  },
  {
    key: "openai",
    label: "OpenAI",
    url: "https://api.openai.com/v1/chat/completions",
    model: "gpt-6-luna",
  },
  {
    key: "openrouter",
    label: "OpenRouter",
    url: "https://openrouter.ai/api/v1/chat/completions",
    model: "openai/gpt-6-luna",
  },
  {
    key: "siliconflow",
    label: "硅基流动",
    url: "https://api.siliconflow.cn/v1/chat/completions",
    model: "Qwen/Qwen3.5-4B",
  },
  {
    key: "gemini",
    label: "Gemini",
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    model: "gemini-3.5-flash-lite",
  },
  {
    key: "anthropic",
    label: "Anthropic",
    url: "https://api.anthropic.com/v1/chat/completions",
    model: "claude-haiku-5-5",
  },
  {
    key: "ollama",
    label: "Ollama 本地",
    url: "http://localhost:11434/v1/chat/completions",
    model: "qwen3.5:4b",
  },
  {
    key: "openai_compatible",
    label: "自定义",
    url: "",
    model: "",
  },
];

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
  const [builtinOpen, setBuiltinOpen] = useState(false);
  const promptsSaveChainRef = useRef<Promise<unknown>>(Promise.resolve());

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

  // Serialize prompt saves: each commit (blur/Enter) fires immediately, but
  // later writes must never overtake earlier ones and clobber newer content.
  const scheduleSavePrompts = useCallback((items: PromptItem[]) => {
    const next = promptsSaveChainRef.current
      .then(() => savePrompts(items as unknown[]))
      .catch(() => {});
    promptsSaveChainRef.current = next;
    return next;
  }, []);

  const savePromptsNow = useCallback(
    async (items: PromptItem[]) => {
      await scheduleSavePrompts(items);
    },
    [scheduleSavePrompts],
  );

  // Clone a built-in template (fresh id) into the user library.
  const addClonedPrompt = useCallback(
    (item: PromptItem) => {
      const updated = [...prompts, cloneBuiltinPrompt(item)];
      setPrompts(updated);
      scheduleSavePrompts(updated);
    },
    [prompts, scheduleSavePrompts],
  );

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
      <PageHeader
        title="文本润色"
        description="用于语音识别后的文本润色与文本结构化，触发请前往「快捷键」页面配置对应提示词的快捷键"
      />
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
                  value={savedProviderCfg.url || currentP.url}
                  onChange={(v) => setLlmField("url", v)}
                  commitOnBlur
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
                  commitOnBlur
                />
              }
            />
            <SectionItem
              title="模型ID"
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

      {/* Prompts */}
      <Section>
        <SectionHeader
          title="文本润色模板"
          action={
            <div className="flex items-center gap-2">
              <Button
                variant="accent"
                onClick={async () => {
                  const updated = [
                    ...prompts,
                    {
                      id: createPromptId(),
                      title: "新建润色模板",
                      hotkey: "",
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
              <Button variant="default" onClick={() => setBuiltinOpen(true)}>
                常用润色提示词
              </Button>
            </div>
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
                      commitOnBlur
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
                  commitOnBlur
                />
              </SectionItem>
            ))}
          </SectionItemList>
        </SectionContent>
      </Section>
      <BuiltinPromptsModal
        open={builtinOpen}
        onClose={() => setBuiltinOpen(false)}
        onAdd={addClonedPrompt}
      />
    </PageLayout>
  );
}

interface BuiltinPromptsModalProps {
  open: boolean;
  onClose: () => void;
  onAdd: (item: PromptItem) => void;
}

/**
 * Picker for built-in prompt templates. Reads the bundled `prompts.json` from
 * the app resource (never user data) via `loadBuiltinPrompts`, and lets the
 * user clone any built-in template into a new custom template. The clone gets a
 * fresh id so it is fully independent — editing/deleting it can never be
 * re-merged from the built-in library on a future app update.
 */
function BuiltinPromptsModal({ open, onClose, onAdd }: BuiltinPromptsModalProps) {
  const [items, setItems] = useState<PromptItem[]>([]);

  useEffect(() => {
    if (!open) return;
    loadBuiltinPrompts()
      .then(setItems)
      .catch(() => setItems([]));
  }, [open]);

  return (
    <Modal open={open} onClose={onClose} title="常用润色提示词">
      <div className="space-y-3 overscroll-y-auto">
        {items.length === 0 ? (
          <p className="text-text-muted">暂无内置润色模板。</p>
        ) : (
          items.map((item) => {
            const preview = item.prompt || "（无内容）";
            return (
              <Section key={item.id}>
                <SectionHeader
                  title={item.title || "未命名模板"}
                  action={
                    <Button
                      variant="accent"
                      onClick={() => {
                        onAdd(cloneBuiltinPrompt(item));
                        onClose();
                      }}
                    >
                      添加
                    </Button>
                  }
                />
                <SectionContent>
                  <p className="text-xs text-text-muted whitespace-pre-wrap">
                    {preview.slice(0, 80)}
                    {preview.length > 80 ? "…" : ""}
                  </p>
                </SectionContent>
              </Section>
            );
          })
        )}
      </div>
    </Modal>
  );
}
