import { Trash } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { loadBuiltinHotwords, loadHotwords, saveHotwords } from "@/settings/bridge";
import { Badge } from "@/settings/components/Badge";
import { Button } from "@/settings/components/Button";
import { Input } from "@/settings/components/Input";
import { Modal } from "@/settings/components/Modal";
import { Toggle } from "@/settings/components/Toggle";
import {
  PageHeader,
  PageLayout,
  Section,
  SectionContent,
  SectionHeader,
  SectionItem,
  SectionItemList,
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

  // active_group is single-select: the one group whose id matches is the default.
  const setActiveGroup = (id: string) => {
    persist({ ...data, active_group: id });
  };

  const removeGroup = (id: string) => {
    const groups = data.groups.filter((g) => g.id !== id);
    const active_group = data.active_group === id ? (groups[0]?.id ?? "") : data.active_group;
    persist({ ...data, groups, active_group });
  };

  const addGroup = () => {
    const id = crypto.randomUUID();
    persist({
      ...data,
      groups: [...data.groups, { id, name: t("ui.hotwords.new_group"), words: [] }],
    });
  };

  // Clone a built-in table (fresh id) into the custom library.
  const addClonedGroup = (group: HotwordGroup) => {
    persist({ ...data, groups: [...data.groups, group] });
  };

  return (
    <PageLayout>
      <PageHeader title={t("ui.hotwords.title")} description={t("ui.hotwords.description")} />
      <div className="flex items-center justify-between">
        <Button variant="accent" onClick={addGroup}>
          {t("ui.hotwords.add_group")}
        </Button>
        <Button variant="default" onClick={() => setBuiltinOpen(true)}>
          {t("ui.hotwords.builtin")}
        </Button>
      </div>
      {data.groups.map((group) => (
        <HotwordGroupItem
          key={group.id}
          group={group}
          isActive={data.active_group === group.id}
          onUpdate={(patch) => updateGroup(group.id, patch)}
          onRemove={() => removeGroup(group.id)}
          onSetActive={() => setActiveGroup(group.id)}
        />
      ))}
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
  isActive,
  onUpdate,
  onRemove,
  onSetActive,
}: {
  group: HotwordGroup;
  isActive: boolean;
  onUpdate: (patch: Partial<HotwordGroup>) => void;
  onRemove: () => void;
  onSetActive: () => void;
}) {
  const { t } = useTranslation();
  const [wordDraft, setWordDraft] = useState("");

  return (
    <Section>
      <SectionHeader
        title={group.name}
        action={
          <div className="flex items-center gap-2">
            <Button size="icon" onClick={onRemove}>
              <Trash size={16} />
            </Button>
            <Toggle
              checked={isActive}
              onChange={(v) => {
                if (v) onSetActive();
              }}
            />
          </div>
        }
      />
      <SectionContent>
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

          <SectionItem title={t("ui.hotwords.add_word")}>
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
          </SectionItem>

          <SectionItem title={t("ui.hotwords.word_list")} last>
            <div className="flex flex-wrap gap-1.5">
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
    <Modal open={open} onClose={onClose} title={t("ui.hotwords.builtin")}>
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
                      {t("ui.hotwords.add")}
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
