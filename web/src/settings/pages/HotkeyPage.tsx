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
  { value: "toggle", label: "ui.hotkey_page.mode_toggle" },
  { value: "hold", label: "ui.hotkey_page.mode_hold" },
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
  const modeOptions = MODE_OPTIONS.map((o) => ({ ...o, label: t(o.label) }));

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
      <PageHeader title={t("ui.hotkey_page.title")} description={t("ui.hotkey_page.description")}>
        <div className="flex flex-col gap-1 mt-2 text-text-muted">
          <p>{t("ui.hotkey_page.toggle_hint")}</p>
          <p>{t("ui.hotkey_page.hold_hint")}</p>
          <p>
            {t("ui.hotkey_page.cancel_hint_prefix")}{" "}
            <KeyCap label={normalizeHotkeyToken("ESC", isMac).main} />{" "}
            {t("ui.hotkey_page.cancel_hint_suffix")}
          </p>
        </div>
      </PageHeader>

      {/* Section 1 — global main key (the hands-free wake key) */}
      <Section data-tour="hotkey-main">
        <SectionHeader title={t("ui.hotkey_page.main_section")} />
        <SectionContent>
          <SectionItemList>
            <SectionItem
              title={t("ui.hotkey_page.wake")}
              tooltip={t("ui.hotkey_page.main_subtitle")}
              last
              action={
                <div data-tour="hotkey-wake-edit">
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
                </div>
              }
            />
          </SectionItemList>
        </SectionContent>
      </Section>

      {/* Section 2 — per-feature hotkeys (voice input + each polish prompt) */}
      <Section data-tour="hotkey-voice">
        <SectionHeader
          title={t("ui.hotkey_page.hotkeys_section")}
          subtitle={t("ui.hotkey_page.hotkeys_subtitle")}
        />
        <SectionContent>
          <SectionItemList>
            <SectionItem
              title={t("ui.hotkey_page.voice_input")}
              action={
                <div className="flex items-center gap-2">
                  {hotkeyMode === "toggle" ? (
                    <>
                      {/* start = main key (locked); stop = independently configurable raw-input key */}
                      <div data-tour="hotkey-voice-start">
                        <HotkeyInput value={hotkeyStr} isMac={isMac} locked />
                      </div>
                      <span className="text-xs text-text-muted">→</span>
                      <div data-tour="hotkey-voice-key">
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
                      </div>
                    </>
                  ) : (
                    <div data-tour="hotkey-voice-key">
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
                    </div>
                  )}
                  <div data-tour="hotkey-voice-mode" data-voice-mode={hotkeyMode}>
                    <SegmentedControl
                      options={modeOptions}
                      value={hotkeyMode}
                      onChange={(v) =>
                        updateApp({
                          hotkey_mode: v,
                          voice_hotkey: voiceHotkey || (v === "toggle" ? hotkeyStr : ""),
                        })
                      }
                    />
                  </div>
                </div>
              }
            />

            <div data-tour="hotkey-templates" className="space-y-2">
              {prompts.length === 0 && (
                <p className="text-sm text-text-muted">{t("ui.hotkey_page.no_templates")}</p>
              )}
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
                          options={modeOptions}
                          value={mode}
                          onChange={(v) => updatePrompt(idx, { hotkey_mode: v })}
                        />
                      </div>
                    }
                  />
                );
              })}
            </div>
          </SectionItemList>
        </SectionContent>
      </Section>
      <Toast toast={toast} />
    </PageLayout>
  );
}
