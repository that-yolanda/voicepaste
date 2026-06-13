import { Trash } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { loadHotwords, saveHotwords } from "@/bridge/settings";
import type { HotwordData } from "@/types/hotwords";
import { Button } from "@/ui/components/Button";
import { Input } from "@/ui/components/Input";
import { Toggle } from "@/ui/components/Toggle";
import { PageHeader, PageLayout, Section, SectionContent } from "@/ui/layout/PageLayout";

export function HotwordsPage() {
  const [data, setData] = useState<HotwordData>({ active_group: null, groups: [] });
  const [newWord, setNewWord] = useState("");

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

  const save = async (updated: HotwordData) => {
    setData(updated);
    await saveHotwords(updated);
  };

  return (
    <PageLayout>
      <PageHeader title="热词库" />
      <Button
        variant="accent"
        onClick={() => {
          const updated = {
            ...data,
            groups: [...data.groups, { name: "新热词组", active: true, words: [] }],
          };
          save(updated);
        }}
      >
        添加热词组
      </Button>
      {data.groups.map((group, gi) => (
        <Section key={group.name}>
          <SectionContent className="space-y-2 py-4">
            <div className="flex items-center gap-2">
              <Input
                value={group.name}
                className="flex-1"
                onChange={(v) => {
                  const updated = { ...data };
                  updated.groups = [...updated.groups];
                  updated.groups[gi] = { ...group, name: v };
                  setData(updated);
                }}
                onBlur={() => saveHotwords(data)}
              />
              <Toggle
                checked={group.active}
                onChange={(v) => {
                  const updated = { ...data };
                  updated.groups = [...updated.groups];
                  updated.groups[gi] = { ...group, active: v };
                  save(updated);
                }}
              />
              <Button
                size="sm"
                onClick={() => {
                  const updated = { ...data };
                  updated.groups = data.groups.filter((_, i) => i !== gi);
                  save(updated);
                }}
              >
                <Trash size={16} />
              </Button>
            </div>

            <Input
              value={newWord}
              onChange={(v) => setNewWord(v)}
              className="w-full"
              inputClassName="h-6 px-2 rounded-full text-xs"
              placeholder="添加热词, 支持 热词+权重，|符号分割，不加权重默认为4，例如: 流式输出|5"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const val = newWord.trim();
                  if (val) {
                    const updated = { ...data };
                    updated.groups = [...updated.groups];
                    updated.groups[gi] = { ...group, words: [...group.words, val] };
                    setNewWord("");
                    save(updated);
                  }
                }
              }}
            />
            <div className="flex flex-wrap gap-1.5">
              {group.words.map((word) => (
                <button
                  type="button"
                  key={word}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-accent-soft text-accent text-xs hover:bg-error/20 hover:text-error transition-colors border-0 cursor-pointer"
                  title="点击移除"
                  onClick={() => {
                    const updated = { ...data };
                    updated.groups = [...updated.groups];
                    updated.groups[gi] = {
                      ...group,
                      words: group.words.filter((w) => w !== word),
                    };
                    save(updated);
                  }}
                >
                  {word}
                  <span className="text-[10px]">×</span>
                </button>
              ))}
            </div>
          </SectionContent>
        </Section>
      ))}
      <p className="text-xs text-text-muted">
        热词库用于提高特定词汇的识别准确率。每个词组可以包含多个热词，激活后生效。
      </p>
    </PageLayout>
  );
}
