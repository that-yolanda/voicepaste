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

export const KEY_NAME_MAP: Record<string, string> = {
  ControlLeft: "ControlLeft",
  ControlRight: "ControlRight",
  ShiftLeft: "ShiftLeft",
  ShiftRight: "ShiftRight",
  AltLeft: "AltLeft",
  AltRight: "AltRight",
  MetaLeft: "MetaLeft",
  MetaRight: "MetaRight",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Backspace: "Backspace",
  Tab: "Tab",
  Space: "Space",
  Escape: "Escape",
  Enter: "Enter",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  CapsLock: "CapsLock",
};

export function isModifier(code: string): boolean {
  return (
    code.startsWith("Control") ||
    code.startsWith("Shift") ||
    code.startsWith("Alt") ||
    code.startsWith("Meta")
  );
}

/**
 * Canonical modifier sort order: Control variants first, then Alt, Shift, Meta.
 * Within each group: Left before Right, bare after specific.
 */
const MOD_ORDER = [
  "ControlLeft",
  "ControlRight",
  "Control",
  "AltLeft",
  "AltRight",
  "Alt",
  "ShiftLeft",
  "ShiftRight",
  "Shift",
  "MetaLeft",
  "MetaRight",
  "Command",
];

function buildHotkeyString(pressed: Set<string>, includeMainKey: boolean): string | null {
  const mods: string[] = [];
  let mainKey = "";
  for (const code of pressed) {
    if (code.startsWith("Control")) {
      mods.push(KEY_NAME_MAP[code] || "ControlLeft");
    } else if (code.startsWith("Shift")) {
      mods.push(KEY_NAME_MAP[code] || "ShiftLeft");
    } else if (code.startsWith("Alt")) {
      mods.push(KEY_NAME_MAP[code] || "AltLeft");
    } else if (code.startsWith("Meta")) {
      mods.push(KEY_NAME_MAP[code] || "MetaLeft");
    } else {
      mainKey = KEY_NAME_MAP[code] || code.replace(/^(Key|Digit)/, "");
    }
  }
  const uniqueMods = [...new Set(mods)];
  const sortedMods = MOD_ORDER.filter((m) => uniqueMods.includes(m));

  if (!includeMainKey && mainKey) return null;
  if (!includeMainKey && sortedMods.length === 0) return null;

  const parts = includeMainKey && mainKey ? [...sortedMods, mainKey] : sortedMods;
  return parts.join("+");
}

/**
 * Record a custom hotkey using DOM keyboard events (window capture phase).
 * Supports left/right modifier distinction and modifier-only hotkeys.
 * Returns { keys, displayString, hotkey }.
 */
export function recordHotkey(): Promise<HotkeyRecordResult> {
  const pressed = new Set<string>();
  const isMacLikePlatform = /\b(Mac|iPhone|iPad|iPod)\b/.test(
    `${navigator.platform || ""} ${navigator.userAgent || ""}`,
  );

  return new Promise((resolve) => {
    let settled = false;
    let modifierTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (result: HotkeyRecordResult) => {
      if (settled) return;
      settled = true;
      if (modifierTimer) clearTimeout(modifierTimer);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      resolve(result);
    };

    const scheduleModifierFinalize = () => {
      if (modifierTimer) clearTimeout(modifierTimer);
      const allModifiers = [...pressed].every(isModifier);
      if (allModifiers && pressed.size > 0) {
        modifierTimer = setTimeout(() => {
          if (settled) return;
          const hotkey = buildHotkeyString(pressed, false);
          if (hotkey) {
            finish({ keys: [hotkey], displayString: hotkey, hotkey });
          }
        }, 300);
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      pressed.add(e.code);

      if (e.code === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish({ keys: [], displayString: "" });
        return;
      }

      // Windows WebView scrolls on Space unless keydown default is blocked.
      // macOS WKWebView: preventDefault on keydown can suppress keyup,
      // so only block default on non-Mac platforms.
      if (!isMacLikePlatform) {
        e.preventDefault();
      }
      e.stopPropagation();

      if (!isModifier(e.code)) {
        if (modifierTimer) clearTimeout(modifierTimer);
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (settled) return;
      e.stopPropagation();

      if (!isModifier(e.code)) {
        const hotkey = buildHotkeyString(pressed, true);
        if (hotkey) {
          finish({ keys: [hotkey], displayString: hotkey, hotkey });
        }
        return;
      }

      if (modifierTimer) clearTimeout(modifierTimer);
      const allModifiers = [...pressed].every(isModifier);
      if (allModifiers && pressed.size > 0) {
        scheduleModifierFinalize();
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
  });
}

// ---- Statistics + History ----

export async function getStats(): Promise<Record<string, unknown>> {
  return invoke("get_stats");
}

export async function getHistory(daysBack = 3): Promise<unknown[]> {
  return invoke("get_history", { daysBack });
}

export async function deleteHistory(ts: number): Promise<void> {
  return invoke("delete_history", { ts });
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
