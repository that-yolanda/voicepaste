import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mock @tauri-apps/api (use vi.hoisted to avoid hoisting issues) ---
const { mockInvoke, mockListen } = vi.hoisted(() => ({
  mockInvoke: vi.fn(() => Promise.resolve()),
  mockListen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mockListen,
}));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  checkForUpdates,
  deleteHistory,
  deleteModel,
  downloadModel,
  downloadUpdate,
  getAccessibilityStatus,
  getData,
  getDownloadedModels,
  getHistory,
  getMicrophoneStatus,
  getModelRegistry,
  getStats,
  isModifier as isModFn,
  KEY_NAME_MAP,
  loadHotwords,
  loadPrompts,
  onEvent,
  onModelDownloadProgress,
  onUpdateProgress,
  recordHotkey,
  reinitHotkey,
  requestMicrophoneAccess,
  saveConfigObject,
  saveHotwords,
  savePrompts,
  selectSoundFile,
} from "@/bridge/settings";

// Re-import private functions via a type cast is not possible, so we test
// recordHotkey's behavior as a public API and extract `isModifier` logic.

// ---- Basic data methods ----

describe("settings bridge — data methods", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("getData invokes get_settings_data", async () => {
    await getData();
    expect(invoke).toHaveBeenCalledWith("get_settings_data");
  });

  it("saveConfigObject invokes save_config_object", async () => {
    await saveConfigObject({ app: { hotkey: "F13" } });
    expect(invoke).toHaveBeenCalledWith("save_config_object", {
      configObject: { app: { hotkey: "F13" } },
    });
  });

  it("getMicrophoneStatus invokes get_microphone_status", async () => {
    await getMicrophoneStatus();
    expect(invoke).toHaveBeenCalledWith("get_microphone_status");
  });

  it("getAccessibilityStatus invokes get_accessibility_status", async () => {
    await getAccessibilityStatus();
    expect(invoke).toHaveBeenCalledWith("get_accessibility_status");
  });

  it("reinitHotkey invokes reinit_hotkey", async () => {
    await reinitHotkey();
    expect(invoke).toHaveBeenCalledWith("reinit_hotkey");
  });

  it("getStats invokes get_stats", async () => {
    await getStats();
    expect(invoke).toHaveBeenCalledWith("get_stats");
  });

  it("getHistory invokes get_history with default daysBack", async () => {
    await getHistory();
    expect(invoke).toHaveBeenCalledWith("get_history", { daysBack: 1 });
  });

  it("getHistory invokes get_history with custom daysBack", async () => {
    await getHistory(7);
    expect(invoke).toHaveBeenCalledWith("get_history", { daysBack: 7 });
  });

  it("deleteHistory invokes delete_history", async () => {
    await deleteHistory(12345);
    expect(invoke).toHaveBeenCalledWith("delete_history", { ts: 12345 });
  });

  it("loadPrompts invokes load_prompts", async () => {
    await loadPrompts();
    expect(invoke).toHaveBeenCalledWith("load_prompts");
  });

  it("savePrompts invokes save_prompts", async () => {
    await savePrompts([{ title: "test" }]);
    expect(invoke).toHaveBeenCalledWith("save_prompts", { prompts: [{ title: "test" }] });
  });

  it("selectSoundFile invokes select_sound_file", async () => {
    await selectSoundFile();
    expect(invoke).toHaveBeenCalledWith("select_sound_file");
  });

  it("checkForUpdates invokes check_for_update", async () => {
    await checkForUpdates();
    expect(invoke).toHaveBeenCalledWith("check_for_update");
  });

  it("downloadUpdate invokes download_and_install_update", async () => {
    await downloadUpdate();
    expect(invoke).toHaveBeenCalledWith("download_and_install_update");
  });

  it("getModelRegistry invokes get_model_registry", async () => {
    await getModelRegistry();
    expect(invoke).toHaveBeenCalledWith("get_model_registry");
  });

  it("getDownloadedModels invokes get_downloaded_models", async () => {
    await getDownloadedModels();
    expect(invoke).toHaveBeenCalledWith("get_downloaded_models");
  });

  it("downloadModel invokes download_model with modelId", async () => {
    await downloadModel("test-model");
    expect(invoke).toHaveBeenCalledWith("download_model", { modelId: "test-model" });
  });

  it("deleteModel invokes delete_model with modelId", async () => {
    await deleteModel("test-model");
    expect(invoke).toHaveBeenCalledWith("delete_model", { modelId: "test-model" });
  });

  it("loadHotwords invokes load_hotwords", async () => {
    await loadHotwords();
    expect(invoke).toHaveBeenCalledWith("load_hotwords");
  });

  it("saveHotwords invokes save_hotwords", async () => {
    await saveHotwords({ active_group: "g1" });
    expect(invoke).toHaveBeenCalledWith("save_hotwords", { data: { active_group: "g1" } });
  });
});

// ---- Event listeners ----

describe("settings bridge — event listeners", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("onEvent returns a cleanup function", () => {
    const cleanup = onEvent(() => {});
    expect(typeof cleanup).toBe("function");
  });

  it("onEvent calls listen with settings:event", () => {
    onEvent(() => {});
    expect(listen).toHaveBeenCalledWith("settings:event", expect.any(Function));
  });

  it("onEvent cleanup calls unlisten", async () => {
    const unlistenFn = vi.fn();
    vi.mocked(listen).mockResolvedValueOnce(unlistenFn as unknown as () => void);
    const cleanup = onEvent(() => {});
    cleanup();
    await vi.waitFor(() => {
      expect(unlistenFn).toHaveBeenCalled();
    });
  });

  it("onUpdateProgress listens to update:progress and update:finished", () => {
    onUpdateProgress(() => {});
    expect(listen).toHaveBeenCalledWith("update:progress", expect.any(Function));
    expect(listen).toHaveBeenCalledWith("update:finished", expect.any(Function));
  });

  it("onModelDownloadProgress calls listen with model:download:progress", () => {
    onModelDownloadProgress(() => {});
    expect(listen).toHaveBeenCalledWith("model:download:progress", expect.any(Function));
  });
});

// ---- Permission: requestMicrophoneAccess ----

describe("settings bridge — requestMicrophoneAccess", () => {
  it("returns granted when getUserMedia succeeds", async () => {
    const mockTrack = { stop: vi.fn() };
    const mockStream = { getTracks: () => [mockTrack] };
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: vi.fn().mockResolvedValue(mockStream) },
      configurable: true,
      writable: true,
    });
    const result = await requestMicrophoneAccess();
    expect(result.status).toBe("granted");
    expect(result.granted).toBe(true);
    expect(mockTrack.stop).toHaveBeenCalled();
  });

  it("returns denied when getUserMedia fails", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      value: {
        getUserMedia: vi.fn().mockRejectedValue(new Error("NotAllowedError")),
      },
      configurable: true,
      writable: true,
    });
    const result = await requestMicrophoneAccess();
    expect(result.status).toBe("denied");
    expect(result.granted).toBe(false);
    expect(result.error).toContain("NotAllowedError");
  });
});

// ---- KEY_NAME_MAP ----

describe("KEY_NAME_MAP", () => {
  it("maps modifier keys correctly", () => {
    expect(KEY_NAME_MAP.ControlLeft).toBe("ControlLeft");
    expect(KEY_NAME_MAP.AltRight).toBe("AltRight");
    expect(KEY_NAME_MAP.MetaLeft).toBe("MetaLeft");
  });

  it("maps special keys", () => {
    expect(KEY_NAME_MAP.ArrowUp).toBe("Up");
    expect(KEY_NAME_MAP.Space).toBe("Space");
    expect(KEY_NAME_MAP.Enter).toBe("Enter");
    expect(KEY_NAME_MAP.Escape).toBe("Escape");
    expect(KEY_NAME_MAP.Backspace).toBe("Backspace");
  });
});

// ---- isModifier ----

describe("isModifier", () => {
  it("returns true for Control/Shift/Alt/Meta prefixes", () => {
    expect(isModFn("ControlLeft")).toBe(true);
    expect(isModFn("ControlRight")).toBe(true);
    expect(isModFn("ShiftLeft")).toBe(true);
    expect(isModFn("AltRight")).toBe(true);
    expect(isModFn("MetaLeft")).toBe(true);
  });

  it("returns false for regular keys", () => {
    expect(isModFn("KeyA")).toBe(false);
    expect(isModFn("Digit1")).toBe(false);
    expect(isModFn("Space")).toBe(false);
    expect(isModFn("Enter")).toBe(false);
  });
});

// ---- Hotkey recording ----

describe("settings bridge — recordHotkey", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function fireKeyEvent(type: "keydown" | "keyup", code: string, opts: { key?: string } = {}) {
    const event = new KeyboardEvent(type, {
      code,
      key: opts.key || code,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);
    return event;
  }

  it("records a single non-modifier key", async () => {
    const promise = recordHotkey();
    fireKeyEvent("keydown", "KeyA");
    fireKeyEvent("keyup", "KeyA");
    const result = await promise;
    expect(result.keys).toEqual(["A"]);
    expect(result.displayString).toBe("A");
  });

  it("records modifier + key combination", async () => {
    const promise = recordHotkey();
    fireKeyEvent("keydown", "ControlLeft");
    fireKeyEvent("keydown", "KeyS");
    fireKeyEvent("keyup", "KeyS");
    const result = await promise;
    expect(result.keys[0]).toContain("Control");
    expect(result.keys[0]).toContain("S");
  });

  it("cancels recording on Escape", async () => {
    const promise = recordHotkey();
    fireKeyEvent("keydown", "Escape");
    const result = await promise;
    expect(result.keys).toEqual([]);
    expect(result.displayString).toBe("");
  });

  it("prevents default on non-Mac platforms during keydown", async () => {
    // jsdom defaults to no platform — we want default prevented (non-Mac)
    const promise = recordHotkey();
    const event = fireKeyEvent("keydown", "Space");
    expect(event.defaultPrevented).toBe(true);
    // Clean up: settle the promise
    fireKeyEvent("keyup", "Space");
    await promise;
  });

  it("cleanup removes event listeners after finish", async () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const promise = recordHotkey();
    fireKeyEvent("keydown", "KeyX");
    fireKeyEvent("keyup", "KeyX");
    await promise;
    expect(removeSpy).toHaveBeenCalledWith("keydown", expect.any(Function), true);
    expect(removeSpy).toHaveBeenCalledWith("keyup", expect.any(Function), true);
    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it("modifier-only hotkey after 300ms timeout", async () => {
    vi.useFakeTimers();
    const promise = recordHotkey();
    fireKeyEvent("keydown", "ControlLeft");
    // Timer is scheduled on keyup of modifier
    fireKeyEvent("keyup", "ControlLeft");
    // Advance past the 300ms debounce
    vi.advanceTimersByTime(350);
    const result = await promise;
    expect(result.keys[0]).toBe("ControlLeft");
    expect(result.displayString).toBe("ControlLeft");
    vi.useRealTimers();
  }, 10000);
});
