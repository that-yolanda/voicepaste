/**
 * Settings bridge — typed API replacing window.voiceSettings.
 * Uses @tauri-apps/api for IPC (invoke + listen).
 *
 * KEY BEHAVIORS PRESERVED (with tests):
 * - Hotkey recording: capture-phase keydown/keyup, pressed Set, canonical mod ordering, 300ms timeout
 * - Space preventDefault: only on non-Mac platforms to avoid suppressing keyup
 * - Tauri listen cleanup: Promise<() => void> async pattern
 * - Permission calls: native platform checks and requests
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { FeedbackEnvironment, FeedbackPayload } from "@/settings/lib/feedback";
import type { HotwordData } from "@/settings/types/hotwords";
import type { PromptItem } from "@/settings/types/prompts";

export async function getFeedbackEnvironment(): Promise<FeedbackEnvironment> {
  return invoke("get_feedback_environment");
}

export async function getFeedbackLog(): Promise<string> {
  return invoke("get_feedback_log");
}

export async function getLogPath(): Promise<string> {
  return invoke("get_log_path");
}

export async function setFeedbackDraftActive(active: boolean): Promise<void> {
  return invoke("set_feedback_draft_active", { active });
}

export async function submitFeedback(
  payload: FeedbackPayload,
): Promise<{ ok: boolean; submissionId: string }> {
  return invoke("submit_feedback", { payload });
}

// ---- Types ----

export interface SettingsData {
  configPath?: string;
  runtime?: Record<string, unknown>;
  parsedConfig?: Record<string, unknown>;
}

export interface ConfigPayload {
  [key: string]: unknown;
}

export interface SettingsEvent {
  type: string;
  payload: Record<string, unknown>;
}

export type PermissionStatus =
  | "granted"
  | "denied"
  | "prompt"
  | "restricted"
  | "unknown"
  | "no_device"
  | "unavailable";

export interface MicStatusResult {
  status: PermissionStatus;
  granted: boolean;
}

export interface AccessibilityResult {
  status: string;
}

export interface LoginItemResult {
  openAtLogin: boolean;
}

export interface HotkeyRecordResult {
  keys: string[];
  displayString: string;
  hotkey?: string;
  /** Present when the recording is rejected as a *main* hotkey (its first
   *  key was a typing key). Main-key callers show it as a toast and keep the
   *  previous hotkey; prompt-key callers ignore the field. */
  invalidReason?: string;
}

export interface UpdateProgress {
  downloaded?: number;
  contentLength?: number;
  finished?: boolean;
}

export interface ModelDownloadProgress {
  model_id: string;
  status: string;
  progress?: number;
}

// ---- Data methods ----

export async function openHelpGuide(): Promise<void> {
  return invoke("plugin:shell|open", {
    path: "https://voicepaste.dev/docs",
  });
}

export async function getData(): Promise<SettingsData> {
  return invoke("get_settings_data");
}

export async function saveConfigObject(config: ConfigPayload): Promise<void> {
  return invoke("save_config_object", { configObject: config });
}

export async function getAudioConfigDefaults(): Promise<Record<string, unknown>> {
  return invoke("get_audio_config_defaults");
}

// ---- Permission methods ----

export async function getMicrophoneStatus(): Promise<{ status: PermissionStatus }> {
  return invoke("get_microphone_status");
}

export async function requestMicrophoneAccess(): Promise<MicStatusResult> {
  return invoke("request_microphone_access");
}

export async function openMicrophoneSettings(): Promise<void> {
  return invoke("open_microphone_settings");
}

export async function getAccessibilityStatus(): Promise<AccessibilityResult> {
  return invoke("get_accessibility_status");
}

export async function openAccessibilitySettings(): Promise<void> {
  return invoke("open_accessibility_settings");
}

export async function reinitHotkey(): Promise<{ active: boolean }> {
  return invoke("reinit_hotkey");
}

// ---- Auto-start ----

export async function getLoginItemSettings(): Promise<LoginItemResult> {
  const autostart = (window as unknown as Record<string, unknown>).__TAURI__ as
    | {
        autostart?: {
          isEnabled: () => Promise<boolean>;
          enable: () => Promise<void>;
          disable: () => Promise<void>;
        };
      }
    | undefined;
  try {
    if (autostart?.autostart) {
      const enabled = await autostart.autostart.isEnabled();
      return { openAtLogin: enabled };
    }
  } catch {
    // fall through
  }
  return { openAtLogin: false };
}

export async function setLoginItemSettings(enabled: boolean): Promise<LoginItemResult> {
  const autostart = (window as unknown as Record<string, unknown>).__TAURI__ as
    | {
        autostart?: {
          isEnabled: () => Promise<boolean>;
          enable: () => Promise<void>;
          disable: () => Promise<void>;
        };
      }
    | undefined;
  if (autostart?.autostart) {
    if (enabled) {
      await autostart.autostart.enable();
    } else {
      await autostart.autostart.disable();
    }
    return { openAtLogin: await autostart.autostart.isEnabled() };
  }
  return { openAtLogin: false };
}

// ---- Hotkey recording ----

/**
 * Record a custom hotkey via the backend keytap tap. The backend can capture
 * keys the WebView never sees as DOM events (e.g. the macOS Fn/Globe key), so
 * this replaces the former in-page DOM keydown listener. Resolves with
 * { keys, displayString, hotkey, invalidReason }; empty `keys` means the user
 * cancelled (Escape) or the ~10s timeout elapsed. `scope: "main"` applies the
 * first-pressed-key rule (rejections come back as `invalidReason`); `"prompt"`
 * never rejects — prompt stop keys are legal bare typing keys.
 */
export async function recordHotkey(scope: "main" | "prompt"): Promise<HotkeyRecordResult> {
  return invoke("record_hotkey", { scope });
}

// ---- Statistics + History ----

export async function getStats(): Promise<Record<string, unknown>> {
  return invoke("get_stats");
}

export async function getHistory(daysBack = 1): Promise<unknown[]> {
  return invoke("get_history", { daysBack });
}

export async function deleteHistory(ts: string): Promise<void> {
  return invoke("delete_history", { ts });
}

/** Start previewing a recording. Replaces any preview already playing. */
export async function playRecordingPreview(filePath: string): Promise<void> {
  return invoke("play_recording_preview", { filePath });
}

/** Stop the recording preview currently playing, if any. */
export async function stopRecordingPreview(): Promise<void> {
  return invoke("stop_recording_preview");
}

/**
 * Notify when a preview stops — whether it finished on its own or was stopped —
 * so the play button can return from its pause state.
 */
export function onPreviewEnded(listener: () => void): () => void {
  let active = true;
  const p = listen<void>("preview:ended", () => {
    if (active) listener();
  });
  return () => {
    active = false;
    p.then((fn) => fn());
  };
}

export async function retryHistoryTranscription(ts: string): Promise<unknown> {
  return invoke("retry_history_transcription", { ts });
}

/** Polish a history entry with `promptId`, or with its own template when omitted. */
export async function repolishHistoryEntry(ts: string, promptId?: string): Promise<unknown> {
  return invoke("repolish_history_entry", { ts, promptId });
}

export async function regenerateHistoryTranscription(ts: string): Promise<unknown> {
  return invoke("regenerate_history_transcription", { ts });
}

// ---- Prompts ----

export async function loadPrompts(): Promise<unknown[]> {
  return invoke("load_prompts");
}

export async function savePrompts(prompts: unknown[]): Promise<void> {
  return invoke("save_prompts", { prompts });
}

/** Load built-in prompt templates from the bundled app resource (read-only).
 * Never touches user data — used by the "常用润色提示词" picker. */
export async function loadBuiltinPrompts(): Promise<PromptItem[]> {
  return invoke("load_builtin_prompts");
}

// ---- Sound ----

export async function selectSoundFile(): Promise<string | null> {
  return invoke("select_sound_file");
}

// ---- Updates ----

export async function checkForUpdates(): Promise<{
  available: boolean;
  version?: string;
  date?: string;
  notes?: string;
}> {
  return invoke("check_for_update");
}

export async function downloadUpdate(): Promise<void> {
  return invoke("download_and_install_update");
}

export async function installUpdate(): Promise<void> {
  const tauri = (window as unknown as Record<string, unknown>).__TAURI__ as
    | { process?: { relaunch: () => Promise<void> } }
    | undefined;
  if (tauri?.process?.relaunch) {
    await tauri.process.relaunch();
  }
}

export function onUpdateProgress(listener: (p: UpdateProgress) => void): () => void {
  let active = true;
  const p = listen<UpdateProgress>("update:progress", (event) => {
    if (active && listener) listener(event.payload);
  });
  const f = listen<void>("update:finished", () => {
    if (active && listener) listener({ finished: true });
  });
  return () => {
    active = false;
    p.then((fn) => fn());
    f.then((fn) => fn());
  };
}

// ---- Settings events ----

export function onEvent(listener: (event: SettingsEvent) => void): () => void {
  let active = true;
  const unlisten = listen<SettingsEvent>("settings:event", (event) => {
    if (active && listener) {
      listener(event.payload);
    }
  });
  return () => {
    active = false;
    unlisten.then((fn) => fn());
  };
}

// ---- Model management ----

export async function getModelRegistry(): Promise<unknown[]> {
  const result = await invoke<{ models?: unknown[] } | unknown[]>("get_model_registry");
  // Backend returns { version, models: [...] }; extract the models array.
  if (result && typeof result === "object" && "models" in result && Array.isArray(result.models)) {
    return result.models;
  }
  return Array.isArray(result) ? result : [];
}

export async function getDownloadedModels(): Promise<string[]> {
  const result = await invoke<{ models?: string[] } | string[]>("get_downloaded_models");
  // Backend returns { models: [...] }; extract the models array.
  if (result && typeof result === "object" && "models" in result && Array.isArray(result.models)) {
    return result.models;
  }
  return Array.isArray(result) ? result : [];
}

export async function downloadModel(modelId: string): Promise<void> {
  return invoke("download_model", { modelId });
}

export function onModelDownloadProgress(listener: (p: ModelDownloadProgress) => void): () => void {
  let active = true;
  const unlisten = listen<ModelDownloadProgress>("model:download:progress", (event) => {
    if (active && listener) {
      listener(event.payload);
    }
  });
  return () => {
    active = false;
    unlisten.then((fn) => fn());
  };
}

export async function deleteModel(modelId: string): Promise<void> {
  return invoke("delete_model", { modelId });
}

// ---- Hotword management ----

/** Load the user's custom hotword library from user data. */
export async function loadHotwords(): Promise<HotwordData> {
  return invoke("load_hotwords");
}

/** Save the user's custom hotword library to user data. */
export async function saveHotwords(data: HotwordData): Promise<void> {
  return invoke("save_hotwords", { data });
}

/** Load built-in hotword tables from the bundled app resource (read-only).
 * Never touches user data — used by the "常用热词表" picker. */
export async function loadBuiltinHotwords(): Promise<HotwordData> {
  return invoke("load_builtin_hotwords");
}

/** Check a prospective shortcut edit without changing persisted settings. */
export function validateHotkeySettings(
  configObject: ConfigPayload,
  prompts: PromptItem[],
  targetId?: string,
): Promise<void> {
  return invoke("validate_hotkey_settings", {
    configObject,
    prompts,
    ...(targetId ? { targetId } : {}),
  });
}
