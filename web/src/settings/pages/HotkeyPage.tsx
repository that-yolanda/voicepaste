import { useCallback, useEffect, useState } from "react";
import type { HotkeyRecordResult } from "@/settings/bridge";
import { loadPrompts, recordHotkey, savePrompts } from "@/settings/bridge";
import { Button } from "@/settings/components/Button";
import { KeyCap } from "@/settings/components/KeyCap";
import { SegmentedControl } from "@/settings/components/SegmentedControl";
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
import { formatPromptHotkey, normalizeHotkeyToken } from "@/settings/lib/hotkey";
import { useSettings } from "@/settings/SettingsProvider";
import type { PromptItem } from "@/settings/types/prompts";

export function HotkeyPage() {
  const { settings, scheduleSave } = useSettings();
  const cfg = settings?.parsedConfig || ({} as Record<string, unknown>);
  const app = (cfg.app || {}) as Record<string, unknown>;
  const hotkeyStr = (app.hotkey as string) || "F13";
  const hotkeyMode = (app.hotkey_mode as string) || "toggle";
  const promptHotkeysStopOnly = app.prompt_hotkeys_stop_only === true;
  // Show Apple symbols on macOS, native labels (Ctrl/Alt/Win/Shift) on Windows.
  const isMac = settings?.runtime?.platform === "macos";

  const [recording, setRecording] = useState(false);
  const [prompts, setPrompts] = useState<PromptItem[]>([]);
  const [recordingIdx, setRecordingIdx] = useState<number | null>(null);

  // Any recording in progress (main or prompt) disables all record buttons —
  // the backend keytap recorder handles one combination at a time, so letting
  // a second recording start would race with the in-flight one.
  const anyRecording = recording || recordingIdx !== null;

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
          hotkey: result.hotkey,
          _displayString: result.displayString,
        };
      } else {
        updated[index] = { ...updated[index], hotkey: "" };
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
            <KeyCap label={normalizeHotkeyToken("ESC", isMac).main} /> 取消
          </p>
          <p>按住说话：按住开始，松开结束</p>
        </div>
      </PageHeader>
      <Section>
        <SectionHeader title="默认快捷键" />
        <SectionContent>
          <SectionItemList>
            <SectionItem
              title="快捷键 - 默认"
              last
              action={
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1 flex-wrap border border-border px-2 py-1 rounded-md h-full">
                    {hotkeyStr.split("+").map((k) => {
                      const token = normalizeHotkeyToken(k, isMac);
                      return <KeyCap key={k} label={token.main} side={token.side} />;
                    })}
                  </div>
                  <Button variant="accent" onClick={startRecord} disabled={anyRecording}>
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
          </SectionItemList>
        </SectionContent>
      </Section>

      <Section>
        <SectionHeader title="文本润色快捷键" />
        <SectionContent>
          <SectionItemList>
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
                          .map((k) => {
                            const token = normalizeHotkeyToken(k, isMac);
                            return <KeyCap key={k} label={token.main} side={token.side} />;
                          })
                      ) : (
                        <span className="text-xs text-text-muted">未绑定</span>
                      )}
                    </div>
                    <Button
                      variant="accent"
                      disabled={anyRecording}
                      onClick={() => recordPromptHotkey(idx)}
                    >
                      {recordingIdx === idx ? "录制中…" : "录制"}
                    </Button>
                    <SegmentedControl
                      options={[
                        {
                          value: "toggle",
                          label: promptHotkeysStopOnly ? "点击结束" : "点击切换",
                        },
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

            {prompts.length > 0 && <div className="border-t border-border-subtle" />}

            <SectionItem
              title="润色快捷键仅结束"
              description="开启后，文本润色快捷键仅用于结束语音转文字，减少未开始转文字时的误触发"
              last
              action={
                <Toggle
                  checked={promptHotkeysStopOnly}
                  onChange={(v) => scheduleSave({ app: { prompt_hotkeys_stop_only: v } })}
                />
              }
            />
          </SectionItemList>
        </SectionContent>
      </Section>
    </PageLayout>
  );
}
