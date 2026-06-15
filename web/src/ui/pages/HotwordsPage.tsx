import { Trash } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { loadHotwords, saveHotwords } from "@/bridge/settings";
import type { HotwordData } from "@/types/hotwords";
import { Badge } from "@/ui/components/Badge";
import { Button } from "@/ui/components/Button";
import { Input } from "@/ui/components/Input";
import { Toggle } from "@/ui/components/Toggle";
import {
  PageHeader,
  PageLayout,
  Section,
  SectionContent,
  SectionHeader,
  SectionItem,
  SectionItemList,
} from "@/ui/layout/PageLayout";

export function HotwordsPage() {
  const [data, setData] = useState<HotwordData>({
    active_group: null,
    groups: [],
  });
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
      <PageHeader
        title="热词库"
        description="热词库用于提高特定词汇的识别准确率。ASR模型支持热词则自动传入模型识别，若模型不支持可追加到 LLM 的文本润色中，或同时开启以强化热词准确率，配置前往 音频模型 > 自定义配置 > 识别强化。"
      />
      <Button
        variant="accent"
        onClick={() => {
          const updated = {
            ...data,
            groups: [
              ...data.groups,
              { name: "新热词组", active: true, words: [] },
            ],
          };
          save(updated);
        }}
      >
        添加热词组
      </Button>
      {data.groups.map((group, gi) => (
        <Section key={group.name}>
          <SectionHeader
            title={group.name || "未命名热词组"}
            action={
              <div className="flex items-center gap-2">
                <Button
                  size="icon"
                  onClick={() => {
                    const updated = { ...data };
                    updated.groups = data.groups.filter((_, i) => i !== gi);
                    save(updated);
                  }}
                >
                  <Trash size={16} />
                </Button>
                <Toggle
                  checked={group.active}
                  onChange={(v) => {
                    const updated = { ...data };
                    updated.groups = [...updated.groups];
                    updated.groups[gi] = { ...group, active: v };
                    save(updated);
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
                    value={group.name}
                    className="w-full"
                    onChange={(v) => {
                      const updated = { ...data };
                      updated.groups = [...updated.groups];
                      updated.groups[gi] = { ...group, name: v };
                      setData(updated);
                    }}
                    onBlur={() => saveHotwords(data)}
                  />
                }
              />

              <SectionItem title="添加热词">
                <Input
                  value={newWord}
                  onChange={(v) => setNewWord(v)}
                  className="w-full"
                  placeholder="支持「热词|权重」，不加权重默认为 4，例如：流式输出|5"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const val = newWord.trim();
                      if (val) {
                        const updated = { ...data };
                        updated.groups = [...updated.groups];
                        updated.groups[gi] = {
                          ...group,
                          words: [...group.words, val],
                        };
                        setNewWord("");
                        save(updated);
                      }
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
                    </Badge>
                  ))}
                </div>
              </SectionItem>
            </SectionItemList>
          </SectionContent>
        </Section>
      ))}
    </PageLayout>
  );
}
