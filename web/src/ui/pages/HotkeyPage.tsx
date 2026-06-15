import { useCallback, useEffect, useState } from "react";
import type { HotkeyRecordResult } from "@/bridge/settings";
import { loadPrompts, recordHotkey, savePrompts } from "@/bridge/settings";
import { formatPromptHotkey, normalizeHotkeyLabel } from "@/lib/hotkey";
import { Button } from "@/ui/components/Button";
import { KeyCap } from "@/ui/components/KeyCap";
import { SegmentedControl } from "@/ui/components/SegmentedControl";
import {
  PageHeader,
  PageLayout,
  Section,
  SectionContent,
  SectionItem,
  SectionItemList,
} from "@/ui/layout/PageLayout";
import { useSettings } from "@/ui/SettingsProvider";

interface PromptItem {
  id: string;
  title: string;
  hotkey?: string[];
  hotkey_mode?: string;
  prompt?: string;
  _displayString?: string;
}

export function HotkeyPage() {
  const { settings, scheduleSave } = useSettings();
  const cfg = settings?.parsedConfig || ({} as Record<string, unknown>);
  const app = (cfg.app || {}) as Record<string, string | undefined>;
  const hotkeyStr = app.hotkey || "F13";
  const hotkeyMode = (app.hotkey_mode as string) || "toggle";

  const [recording, setRecording] = useState(false);
  const [prompts, setPrompts] = useState<PromptItem[]>([]);
  const [recordingIdx, setRecordingIdx] = useState<number | null>(null);

  useEffect(() => {
    loadPrompts()
      .then((d) => {
        if (Array.isArray(d)) setPrompts(d as unknown as PromptItem[]);
      })
      .catch(() => {});
  }, []);

  const startRecord = useCallback(async () => {
    setRecording(true);
    const result: HotkeyRecordResult = await recordHotkey();
    setRecording(false);
    if (result.keys.length > 0) {
      scheduleSave({ app: { hotkey: result.keys[0] } });
    }
  }, [scheduleSave]);

  const recordPromptHotkey = useCallback(
    async (index: number) => {
      if (recordingIdx !== null) return;
      setRecordingIdx(index);
      const result: HotkeyRecordResult = await recordHotkey();
      setRecordingIdx(null);
      const updated = [...prompts];
      if (result.hotkey) {
        updated[index] = {
          ...updated[index],
          hotkey: [result.hotkey],
          _displayString: result.displayString,
        };
      } else {
        updated[index] = { ...updated[index], hotkey: [] };
        delete updated[index]._displayString;
      }
      setPrompts(updated);
      await savePrompts(updated as unknown[]);
    },
    [prompts, recordingIdx],
  );

  return (
    <PageLayout>
      <PageHeader title="快捷键" description="为语音输入配置自定义快捷键。">
        <div className="space-y-2 text-xs text-text-muted py-2">
          <p>
            点击切换：按一次开始，按一次结束，
            <KeyCap label={normalizeHotkeyLabel("ESC")} /> 取消
          </p>
          <p>按住说话：按住开始，松开结束</p>
        </div>
      </PageHeader>
      <Section>
        <SectionContent>
          <SectionItemList>
            <SectionItem
              title="快捷键 - 默认"
              action={
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1 flex-wrap border border-border px-2 py-1 rounded-md h-full">
                    {hotkeyStr.split("+").map((k) => (
                      <KeyCap key={k} label={normalizeHotkeyLabel(k)} />
                    ))}
                  </div>
                  <Button variant="accent" onClick={startRecord} disabled={recording}>
                    {recording ? "请按键…" : "录制"}
                  </Button>
                  <SegmentedControl
                    options={[
                      { value: "toggle", label: "点击切换" },
                      { value: "hold", label: "按住说话" },
                    ]}
                    value={hotkeyMode}
                    onChange={(v) => scheduleSave({ app: { hotkey_mode: v } })}
                  />
                </div>
              }
            />

            {/* Prompt hotkeys */}
            {prompts.map((item, idx) => (
              <SectionItem
                key={item.id}
                title={`快捷键 - ${item.title || "未命名模板"}`}
                last={idx === prompts.length - 1}
                action={
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1 flex-wrap border border-border px-2 py-1 rounded-md h-full">
                      {item._displayString || formatPromptHotkey(item.hotkey) ? (
                        (item._displayString || formatPromptHotkey(item.hotkey))
                          .split("+")
                          .map((k) => <KeyCap key={k} label={normalizeHotkeyLabel(k)} />)
                      ) : (
                        <span className="text-xs text-text-muted">未绑定</span>
                      )}
                    </div>
                    <Button
                      variant="accent"
                      disabled={recordingIdx !== null}
                      onClick={() => recordPromptHotkey(idx)}
                    >
                      {recordingIdx === idx ? "录制中…" : "录制"}
                    </Button>
                    <SegmentedControl
                      options={[
                        { value: "toggle", label: "点击切换" },
                        { value: "hold", label: "按住说话" },
                      ]}
                      value={item.hotkey_mode || "toggle"}
                      onChange={async (v) => {
                        const updated = [...prompts];
                        updated[idx] = { ...updated[idx], hotkey_mode: v };
                        setPrompts(updated);
                        await savePrompts(updated as unknown[]);
                      }}
                    />
                  </div>
                }
              />
            ))}
          </SectionItemList>
        </SectionContent>
      </Section>
    </PageLayout>
  );
}
