/**
 * Settings bridge — typed API replacing window.voiceSettings.
 * Uses @tauri-apps/api for IPC (invoke + listen).
 *
 * KEY BEHAVIORS PRESERVED (with tests):
 * - Hotkey recording: capture-phase keydown/keyup, pressed Set, canonical mod ordering, 300ms timeout
 * - Space preventDefault: only on non-Mac platforms to avoid suppressing keyup
 * - Tauri listen cleanup: Promise<() => void> async pattern
 * - Permission calls: getUserMedia -> release stream immediately
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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

export interface MicStatusResult {
  status: "granted" | "denied" | "prompt" | "restricted";
  granted: boolean;
  error?: string;
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

export async function getMicrophoneStatus(): Promise<{ status: string }> {
  return invoke("get_microphone_status");
}

/**
 * Request microphone access via getUserMedia.
 * Opens the system permission dialog, then immediately releases the stream.
 */
export async function requestMicrophoneAccess(): Promise<MicStatusResult> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => {
      t.stop();
    });
    return { status: "granted", granted: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { status: "denied", granted: false, error: message };
  }
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
 * { keys, displayString, hotkey }; empty `keys` means the user cancelled
 * (Escape) or the ~10s timeout elapsed.
 */
export async function recordHotkey(): Promise<HotkeyRecordResult> {
  return invoke("record_hotkey");
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

export async function playSoundFile(filePath: string): Promise<void> {
  return invoke("play_sound_file", { filePath });
}

export async function retryHistoryTranscription(ts: string): Promise<unknown> {
  return invoke("retry_history_transcription", { ts });
}

// ---- Prompts ----

export async function loadPrompts(): Promise<unknown[]> {
  return invoke("load_prompts");
}

export async function savePrompts(prompts: unknown[]): Promise<void> {
  return invoke("save_prompts", { prompts });
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

export async function loadHotwords(): Promise<unknown> {
  return invoke("load_hotwords");
}

export async function saveHotwords(data: unknown): Promise<void> {
  return invoke("save_hotwords", { data });
}
