import { Library, Plus, Trash } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { loadBuiltinPrompts, loadPrompts, savePrompts } from "@/settings/bridge";
import { Button } from "@/settings/components/Button";
import { Input } from "@/settings/components/Input";
import { Modal } from "@/settings/components/Modal";
import { Textarea } from "@/settings/components/Textarea";
import {
  PageLayout,
  Section,
  SectionContent,
  SectionHeader,
  SectionItem,
} from "@/settings/layout/PageLayout";
import { cloneBuiltinPrompt } from "@/settings/lib/prompts";
import type { PromptItem } from "@/settings/types/prompts";

let promptIdCounter = 1;
function createPromptId(): string {
  return `p_${Date.now()}_${promptIdCounter++}`;
}

export function TemplatesPage() {
  const { t } = useTranslation();
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

  return (
    <PageLayout>
      <div className="flex items-center justify-between">
        <span data-tour="llm-add-template" className="inline-flex">
          <Button
            variant="accent"
            onClick={async () => {
              const updated = [
                ...prompts,
                {
                  id: createPromptId(),
                  title: t("ui.llm.new_template"),
                  hotkey: "",
                  hotkey_mode: "toggle",
                  prompt: "",
                },
              ];
              setPrompts(updated);
              await savePromptsNow(updated);
            }}
          >
            <Plus size={14} aria-hidden="true" />
            {t("ui.llm.add_template")}
          </Button>
        </span>
        <span data-tour="llm-library" className="inline-flex">
          <Button variant="default" onClick={() => setBuiltinOpen(true)}>
            <Library size={14} aria-hidden="true" />
            {t("ui.llm.builtin_prompts")}
          </Button>
        </span>
      </div>
      {prompts.map((item, index) => (
        <Section key={item.id} data-tour="llm-templates">
          <SectionContent>
            <SectionItem
              title={t("ui.llm.template_name")}
              last
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
                    placeholder={t("ui.llm.template_name_placeholder")}
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
                placeholder={t("ui.llm.system_prompt_placeholder")}
                commitOnBlur
              />
            </SectionItem>
          </SectionContent>
        </Section>
      ))}
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
  const { t } = useTranslation();
  const [items, setItems] = useState<PromptItem[]>([]);

  useEffect(() => {
    if (!open) return;
    loadBuiltinPrompts()
      .then(setItems)
      .catch(() => setItems([]));
  }, [open]);

  return (
    <Modal open={open} onClose={onClose} title={t("ui.llm.builtin_prompts")}>
      <div className="space-y-3 overscroll-y-auto">
        {items.length === 0 ? (
          <p className="text-text-muted">{t("ui.llm.no_builtin")}</p>
        ) : (
          items.map((item) => {
            const preview = item.prompt || t("ui.llm.empty_content");
            return (
              <Section key={item.id}>
                <SectionHeader
                  title={item.title || t("ui.llm.untitled")}
                  action={
                    <Button
                      variant="accent"
                      onClick={() => {
                        onAdd(cloneBuiltinPrompt(item));
                        onClose();
                      }}
                    >
                      {t("ui.llm.add")}
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
