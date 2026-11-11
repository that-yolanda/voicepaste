import { Lightbulb, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { loadBuiltinHotwords, loadHotwords, saveHotwords } from "@/settings/bridge";
import { Badge } from "@/settings/components/Badge";
import { Button } from "@/settings/components/Button";
import { CurrentUsageBadge } from "@/settings/components/DefaultAction";
import { Input } from "@/settings/components/Input";
import { Modal } from "@/settings/components/Modal";
import {
  PageLayout,
  Section,
  SectionAccordionItem,
  SectionContent,
  SectionHeader,
  SectionItem,
  SectionItemList,
  SectionRows,
} from "@/settings/layout/PageLayout";
import { cloneBuiltinGroup, mergeHotwords, parseHotwordInput } from "@/settings/lib/hotwords";
import type { HotwordData, HotwordGroup } from "@/settings/types/hotwords";

export function HotwordsPage() {
  const { t } = useTranslation();
  const [data, setData] = useState<HotwordData>({
    active_group: "",
    groups: [],
  });
  const [builtinOpen, setBuiltinOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const hw = await loadHotwords();
      if (hw) setData(hw);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const persist = (next: HotwordData) => {
    setData(next);
    saveHotwords(next);
  };

  const updateGroup = (id: string, patch: Partial<HotwordGroup>) => {
    persist({
      ...data,
      groups: data.groups.map((g) => (g.id === id ? { ...g, ...patch } : g)),
    });
  };

  const removeGroup = (id: string) => {
    const groups = data.groups.filter((g) => g.id !== id);
    const active_group = data.active_group === id ? (groups[0]?.id ?? "") : data.active_group;
    persist({ ...data, groups, active_group });
  };

  const addGroup = () => {
    const id = crypto.randomUUID();
    setExpandedId(id);
    persist({
      ...data,
      groups: [...data.groups, { id, name: t("ui.hotwords.new_group"), words: [] }],
    });
  };

  // Clone a built-in table (fresh id) into the custom library.
  const addClonedGroup = (group: HotwordGroup) => {
    setExpandedId(group.id);
    persist({ ...data, groups: [...data.groups, group] });
  };

  return (
    <PageLayout>
      {data.groups.length > 0 && (
        <SectionRows>
          {data.groups.map((group) => (
            <SectionAccordionItem
              key={group.id}
              title={group.name}
              status={data.active_group === group.id ? <CurrentUsageBadge size="xs" /> : undefined}
              open={expandedId === group.id}
              onToggle={() => {
                setExpandedId(expandedId === group.id ? null : group.id);
                if (data.active_group !== group.id) {
                  persist({ ...data, active_group: group.id });
                }
              }}
            >
              <HotwordGroupItem
                group={group}
                onUpdate={(patch) => updateGroup(group.id, patch)}
                onRemove={() => removeGroup(group.id)}
              />
            </SectionAccordionItem>
          ))}
        </SectionRows>
      )}
      <div className="flex items-center gap-2">
        <Button variant="ghost" onClick={addGroup}>
          <Plus size={14} aria-hidden="true" />
          {t("ui.library.add")}
        </Button>
        <Button variant="ghost" onClick={() => setBuiltinOpen(true)}>
          <Lightbulb size={14} aria-hidden="true" />
          {t("ui.library.templates")}
        </Button>
      </div>
      <BuiltinHotwordsModal
        open={builtinOpen}
        onClose={() => setBuiltinOpen(false)}
        onAdd={addClonedGroup}
      />
    </PageLayout>
  );
}

function HotwordGroupItem({
  group,
  onUpdate,
  onRemove,
}: {
  group: HotwordGroup;
  onUpdate: (patch: Partial<HotwordGroup>) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const [wordDraft, setWordDraft] = useState("");

  return (
    <Section>
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="icon" title={t("ui.library.remove")} onClick={onRemove}>
          <Trash2 size={14} />
        </Button>
      </div>
      <SectionContent plain>
        <SectionItemList>
          <SectionItem
            title={t("ui.hotwords.group_name")}
            action={
              <Input
                className="w-full"
                value={group.name}
                commitOnBlur
                onChange={(v) => onUpdate({ name: v })}
              />
            }
          />

          <SectionItem title={t("ui.hotwords.word")} last>
            <Input
              className="w-full"
              value={wordDraft}
              onChange={setWordDraft}
              placeholder={t("ui.hotwords.add_word_placeholder")}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const entries = parseHotwordInput(wordDraft);
                  if (entries.length > 0) {
                    onUpdate({ words: mergeHotwords(group.words, entries) });
                  }
                  setWordDraft("");
                }
              }}
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {group.words.map((word) => (
                <Badge
                  key={word}
                  variant="accent"
                  title={t("ui.hotwords.remove_word")}
                  onClick={() => onUpdate({ words: group.words.filter((w) => w !== word) })}
                >
                  {word}
                  <span className="text-[10px]">×</span>
                </Badge>
              ))}
            </div>
          </SectionItem>
        </SectionItemList>
      </SectionContent>
    </Section>
  );
}

/** Max words shown as preview badges per built-in table. */
const PREVIEW_WORDS = 8;

interface BuiltinHotwordsModalProps {
  open: boolean;
  onClose: () => void;
  /** Called with a fresh custom group cloned from the chosen built-in table. */
  onAdd: (group: HotwordGroup) => void;
}

/**
 * Picker for built-in hotword tables. Reads the bundled `hotwords.json` from
 * the app resource (never user data) via `loadBuiltinHotwords`, and lets the
 * user clone any built-in table into a new custom table. The clone gets a fresh
 * id so it is fully independent — editing/deleting it can never be re-merged
 * from the built-in library on a future app update.
 */
function BuiltinHotwordsModal({ open, onClose, onAdd }: BuiltinHotwordsModalProps) {
  const { t } = useTranslation();
  const [groups, setGroups] = useState<HotwordGroup[]>([]);

  useEffect(() => {
    if (!open) return;
    loadBuiltinHotwords()
      .then((data) => setGroups(data.groups))
      .catch(() => setGroups([]));
  }, [open]);

  return (
    <Modal open={open} onClose={onClose} title={t("ui.library.templates")}>
      <div className="space-y-3 overscroll-y-auto">
        {groups.length === 0 ? (
          <p className="text-text-muted">{t("ui.hotwords.no_builtin")}</p>
        ) : (
          groups.map((group) => {
            const preview = group.words.slice(0, PREVIEW_WORDS);
            const rest = group.words.length - preview.length;
            return (
              <Section key={group.id}>
                <SectionHeader
                  title={group.name}
                  action={
                    <Button
                      variant="accent"
                      onClick={() => {
                        onAdd(cloneBuiltinGroup(group));
                        onClose();
                      }}
                    >
                      {t("ui.library.add")}
                    </Button>
                  }
                />

                <SectionContent>
                  <div className="flex flex-wrap gap-2">
                    {preview.map((word) => (
                      <Badge key={word} variant="muted">
                        {word}
                      </Badge>
                    ))}
                    {rest > 0 && <Badge variant="muted">+{rest}</Badge>}
                  </div>
                </SectionContent>
              </Section>
            );
          })
        )}
      </div>
    </Modal>
  );
}
