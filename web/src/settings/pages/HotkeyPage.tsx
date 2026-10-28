import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { errText } from "@/i18n/errText";
import { loadPrompts, savePrompts, validateHotkeySettings } from "@/settings/bridge";
import { HotkeyInput } from "@/settings/components/HotkeyInput";
import { KeyCap } from "@/settings/components/KeyCap";
import { SegmentedControl } from "@/settings/components/SegmentedControl";
import { Toast, useToast } from "@/settings/components/Toast";
import {
  PageHeader,
  PageLayout,
  Section,
  SectionContent,
  SectionHeader,
  SectionItem,
  SectionItemList,
} from "@/settings/layout/PageLayout";
import { normalizeHotkeyToken } from "@/settings/lib/hotkey";
import { useSettings } from "@/settings/SettingsProvider";
import type { PromptItem } from "@/settings/types/prompts";

const MODE_OPTIONS = [
  { value: "toggle", label: "免提模式" },
  { value: "hold", label: "按住说话" },
];

export function HotkeyPage() {
  const { t } = useTranslation();
  const { settings, scheduleSave, refresh } = useSettings();
  const cfg = settings?.parsedConfig || ({} as Record<string, unknown>);
  const app = (cfg.app || {}) as Record<string, string | undefined>;
  const isMac = settings?.runtime?.platform === "macos";
  // Keep an explicit empty string (user cleared the key) distinct from missing.
  const hotkeyStr = app.hotkey ?? (isMac ? "MetaLeft" : "ControlLeft");
  const voiceHotkey = app.voice_hotkey ?? (app.hotkey_mode === "hold" ? "" : hotkeyStr);
  const issues = (settings?.runtime?.hotkeyIssues ?? []) as {
    id: string;
    code: string;
    params?: Record<string, string>;
  }[];
  const hotkeyMode = (app.hotkey_mode as string) || "toggle";
  const { toast, showToast } = useToast();

  const [prompts, setPrompts] = useState<PromptItem[]>([]);
  // Which field is currently capturing — only one recorder runs at a time, so
  // every other recordable field goes `busy` while it is set.
  const [activeRecorder, setActiveRecorder] = useState<string | null>(null);

  useEffect(() => {
    loadPrompts()
      .then((d) => {
        if (Array.isArray(d)) setPrompts(d as unknown as PromptItem[]);
      })
      .catch(() => {});
  }, []);

  const isBusyFor = useCallback(
    (id: string) => activeRecorder !== null && activeRecorder !== id,
    [activeRecorder],
  );

  // Existing disabled bindings are reported once per visit, never as persistent
  // inline errors. An intentionally empty shortcut is a normal disabled state.
  const shownIssues = useRef(new Set<string>());
  useEffect(() => {
    // Reserved binding titles are localized here; prompt templates carry their
    // user-editable title verbatim.
    const bindingTitle = (title: string): string =>
      title === "main"
        ? t("ui.hotkey.binding_main")
        : title === "voice"
          ? t("ui.hotkey.binding_voice")
          : title;
    const messages = issues
      .map((issue) => {
        const params = { ...(issue.params ?? {}) };
        if (params.title) params.title = bindingTitle(params.title);
        if (params.aTitle) params.aTitle = bindingTitle(params.aTitle);
        if (params.bTitle) params.bTitle = bindingTitle(params.bTitle);
        return t(`errors.${issue.code}`, params);
      })
      .filter((message) => !shownIssues.current.has(message));
    for (const message of messages) shownIssues.current.add(message);
    if (messages.length > 0) showToast(messages.join("；"), "error");
  }, [issues, showToast, t]);

  const updatePrompt = useCallback(
    async (index: number, patch: Partial<PromptItem>) => {
      let updated = prompts.map((p, i) => (i === index ? { ...p, ...patch } : p));
      try {
        let clearedReason: string | undefined;
        const targetId =
          patch.hotkey_mode === undefined ? undefined : `prompt:${prompts[index].id}`;
        try {
          await validateHotkeySettings(cfg, updated, targetId);
        } catch (error) {
          if (patch.hotkey_mode === undefined) throw error;
          updated = updated.map((p, i) => (i === index ? { ...p, hotkey: "" } : p));
          await validateHotkeySettings(cfg, updated, targetId);
          clearedReason = `${errText(error)}；${t("ui.hotkey.cleared_hint")}`;
        }
        await savePrompts(updated as unknown[]);
        setPrompts(updated);
        await refresh();
        if (clearedReason) showToast(clearedReason, "error");
      } catch (error) {
        showToast(errText(error), "error");
      }
    },
    [cfg, prompts, refresh, showToast, t],
  );

  const updateApp = useCallback(
    async (patch: Record<string, string>) => {
      try {
        let updates = patch;
        let clearedReason: string | undefined;
        const targetId = patch.hotkey_mode === undefined ? undefined : "voice";
        try {
          await validateHotkeySettings({ ...cfg, app: { ...app, ...updates } }, prompts, targetId);
        } catch (error) {
          if (patch.hotkey_mode === undefined) throw error;
          updates = { ...patch, voice_hotkey: "" };
          await validateHotkeySettings({ ...cfg, app: { ...app, ...updates } }, prompts, targetId);
          clearedReason = `${errText(error)}；${t("ui.hotkey.cleared_hint")}`;
        }
        await scheduleSave({ app: updates });
        if (clearedReason) showToast(clearedReason, "error");
      } catch (error) {
        showToast(errText(error), "error");
      }
    },
    [cfg, app, prompts, scheduleSave, showToast, t],
  );

  // The recordable hotkey field for one prompt row — its "stop" key in toggle
  // mode, its single key in hold mode. The "start" side is rendered separately
  // as the locked global main key.
  const promptRecorderProps = useCallback(
    (item: PromptItem, index: number) => {
      const recorderId = `prompt:${item.id}`;
      return {
        isMac,
        validateFirstKey: item.hotkey_mode === "hold",
        onInvalid: (reason: string) => showToast(errText({ code: reason }), "error"),
        busy: isBusyFor(recorderId),
        onStart: () => setActiveRecorder(recorderId),
        onDone: () => setActiveRecorder(null),
        onCommit: (hk: string) => updatePrompt(index, { hotkey: hk }),
        onClear: () => updatePrompt(index, { hotkey: "" }),
      };
    },
    [isMac, isBusyFor, updatePrompt, showToast],
  );

  return (
    <PageLayout>
      <PageHeader title="快捷键" description="为语音输入配置自定义快捷键。">
        <div className="flex flex-col gap-1 mt-2 text-text-muted">
          <p>免提模式：按全局主键开始，按语音输入或润色模板各自的结束键完成；</p>
          <p>按住说话：完整按住对应快捷键 500ms 后开始，松开结束；启动后其他按键不改变本次录音。</p>
          <p>
            录制快捷键时按 <KeyCap label={normalizeHotkeyToken("ESC", isMac).main} /> 取消
          </p>
        </div>
      </PageHeader>

      {/* Section 1 — global main key (the hands-free wake key) */}
      <Section>
        <SectionHeader
          title="全局语音主键"
          subtitle="所有免提模式均以此键开始录音；按住说话需另设独立快捷键。使用以辅助键（如 Ctrl、Shift、Tab 等）或 F1 等功能键为首的按键作为主键。"
        />
        <SectionContent>
          <SectionItemList>
            <SectionItem
              title="语音唤起"
              last
              action={
                <HotkeyInput
                  value={hotkeyStr}
                  isMac={isMac}
                  busy={isBusyFor("main")}
                  onStart={() => setActiveRecorder("main")}
                  onDone={() => setActiveRecorder(null)}
                  onCommit={(hk) => updateApp({ hotkey: hk })}
                  onClear={() => updateApp({ hotkey: "" })}
                  validateFirstKey
                  onInvalid={(reason) => showToast(errText({ code: reason }), "error")}
                />
              }
            />
          </SectionItemList>
        </SectionContent>
      </Section>

      {/* Section 2 — per-feature hotkeys (voice input + each polish prompt) */}
      <Section>
        <SectionHeader title="快捷键" subtitle="点击输入框进入录制 → 按下快捷键" />
        <SectionContent>
          <SectionItemList>
            <SectionItem
              title="语音输入"
              action={
                <div className="flex items-center gap-2">
                  {hotkeyMode === "toggle" ? (
                    <>
                      {/* start = main key (locked); stop = independently configurable raw-input key */}
                      <HotkeyInput value={hotkeyStr} isMac={isMac} locked />
                      <span className="text-xs text-text-muted">→</span>
                      <HotkeyInput
                        value={voiceHotkey}
                        isMac={isMac}
                        busy={isBusyFor("voice")}
                        onStart={() => setActiveRecorder("voice")}
                        onDone={() => setActiveRecorder(null)}
                        onCommit={(hk) => updateApp({ voice_hotkey: hk })}
                        onClear={() => updateApp({ voice_hotkey: "" })}
                        onInvalid={(reason) => showToast(errText({ code: reason }), "error")}
                      />
                    </>
                  ) : (
                    <HotkeyInput
                      value={voiceHotkey}
                      isMac={isMac}
                      validateFirstKey
                      busy={isBusyFor("voice")}
                      onStart={() => setActiveRecorder("voice")}
                      onDone={() => setActiveRecorder(null)}
                      onCommit={(hk) => updateApp({ voice_hotkey: hk })}
                      onClear={() => updateApp({ voice_hotkey: "" })}
                      onInvalid={(reason) => showToast(errText({ code: reason }), "error")}
                    />
                  )}
                  <SegmentedControl
                    options={MODE_OPTIONS}
                    value={hotkeyMode}
                    onChange={(v) =>
                      updateApp({
                        hotkey_mode: v,
                        voice_hotkey: voiceHotkey || (v === "toggle" ? hotkeyStr : ""),
                      })
                    }
                  />
                </div>
              }
            />

            {prompts.map((item, idx) => {
              const mode = item.hotkey_mode || "toggle";
              return (
                <SectionItem
                  key={item.id}
                  title={item.title}
                  last={idx === prompts.length - 1}
                  action={
                    <div className="flex items-center gap-2">
                      {mode === "toggle" ? (
                        <>
                          {/* start = main key (locked); stop = this prompt's polish key */}
                          <HotkeyInput value={hotkeyStr} isMac={isMac} locked />
                          <span className="text-xs text-text-muted">→</span>
                          <HotkeyInput
                            value={item.hotkey || ""}
                            {...promptRecorderProps(item, idx)}
                          />
                        </>
                      ) : (
                        <HotkeyInput
                          value={item.hotkey || ""}
                          {...promptRecorderProps(item, idx)}
                        />
                      )}
                      <SegmentedControl
                        options={MODE_OPTIONS}
                        value={mode}
                        onChange={(v) => updatePrompt(idx, { hotkey_mode: v })}
                      />
                    </div>
                  }
                />
              );
            })}
          </SectionItemList>
        </SectionContent>
      </Section>
      <Toast toast={toast} />
    </PageLayout>
  );
}
