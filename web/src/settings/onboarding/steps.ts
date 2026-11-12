import type { DriveStep } from "driver.js";
import type { TFunction } from "i18next";
import type { SectionId } from "@/settings/layout/Sidebar";

export const TASKS = ["permissions", "models", "hotkey"] as const;
export type TaskId = (typeof TASKS)[number];
export const TASK_DOC: Record<TaskId, string> = {
  permissions: "permissions",
  models: "compatibility",
  hotkey: "hotkeys",
};
export const TASK_SECTION: Record<TaskId, SectionId> = {
  permissions: "app",
  models: "models",
  hotkey: "hotkey",
};

export function getSteps(
  task: TaskId,
  isMac: boolean,
  t: TFunction,
  voiceMode = "toggle",
): DriveStep[] {
  const step = (target: string, key: string): DriveStep => ({
    element: `[data-tour="${target}"]`,
    popover: {
      title: t(`ui.onboarding.steps.${key}.title`),
      description: t(`ui.onboarding.steps.${key}.description`),
      side: "bottom",
      align: "start",
    },
  });
  switch (task) {
    case "permissions":
      return [
        step("microphone", "microphone"),
        ...(isMac ? [step("accessibility", "accessibility")] : []),
      ];
    case "models":
      return [
        step("models-add-provider", "modelProviders"),
        step("models-providers", "modelSetup"),
        step("models-default-asr", "modelSelectAsr"),
        step("models-default-llm", "modelSelectLlm"),
      ];
    case "hotkey":
      return [
        step("hotkey-main", "hotkeyMain"),
        step("hotkey-wake-edit", "hotkeyWakeEdit"),
        step("hotkey-voice-mode", "hotkeyVoice"),
        voiceMode === "hold"
          ? step("hotkey-voice-key", "hotkeyVoiceHold")
          : step("hotkey-voice-start", "hotkeyVoiceStart"),
        step("hotkey-voice-key", "hotkeyVoiceStop"),
        step("hotkey-templates", "hotkeyTemplates"),
      ];
  }
}

/** Wait for React navigation / async model loading without advancing past a missing target. */
export function waitForTarget(selector: string, signal: AbortSignal): Promise<Element> {
  return new Promise((resolve, reject) => {
    const find = () => document.querySelector(selector);
    const found = find();
    if (signal.aborted) return reject(new Error("cancelled"));
    if (found) return resolve(found);
    const cleanup = () => {
      observer.disconnect();
      window.clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
    };
    const cancel = () => {
      cleanup();
      reject(new Error("cancelled"));
    };
    const observer = new MutationObserver(() => {
      const target = find();
      if (target) {
        cleanup();
        resolve(target);
      }
    });
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("missing target"));
    }, 5000);
    signal.addEventListener("abort", cancel, { once: true });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}
