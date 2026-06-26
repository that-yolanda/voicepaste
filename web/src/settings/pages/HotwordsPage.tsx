import { Trash } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { loadHotwords, saveHotwords } from "@/settings/bridge";
import { Badge } from "@/settings/components/Badge";
import { Button } from "@/settings/components/Button";
import { Input } from "@/settings/components/Input";
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
import { mergeHotwords, parseHotwordInput } from "@/settings/lib/hotwords";
import type { HotwordData, HotwordGroup } from "@/settings/types/hotwords";

export function HotwordsPage() {
  const [data, setData] = useState<HotwordData>({ active_group: "", groups: [] });

  const load = useCallback(async () => {
    try {
      const hw = (await loadHotwords()) as unknown as HotwordData;
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
      groups: [...data.groups, { id, name: "新热词组", words: [] }],
    });
  };

  return (
    <PageLayout>
      <PageHeader
        title="热词库"
        description="热词库用于提高特定词汇的识别准确率。开启开关的组为默认热词组，识别时自动传入；若模型不支持热词可追加到 LLM 文本润色，配置前往 音频模型 > 自定义配置 > 识别强化。"
      />
      <Button variant="accent" onClick={addGroup}>
        添加热词组
      </Button>
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
  const [wordDraft, setWordDraft] = useState("");

  return (
    <Section>
      <SectionHeader
        title={group.name || "未命名热词组"}
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
            title="热词组名称"
            action={
              <Input
                className="w-full"
                value={group.name}
                commitOnBlur
                onChange={(v) => onUpdate({ name: v })}
              />
            }
          />

          <SectionItem title="添加热词">
            <Input
              className="w-full"
              value={wordDraft}
              onChange={setWordDraft}
              placeholder="逗号分隔批量添加，例如：Claude, Anthropic|8（默认权重 4）"
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

          <SectionItem title="热词列表" last>
            <div className="flex flex-wrap gap-1.5">
              {group.words.map((word) => (
                <Badge
                  key={word}
                  variant="accent"
                  title="点击移除"
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
