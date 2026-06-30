import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mock @tauri-apps/api (use vi.hoisted to avoid hoisting issues) ---
const { mockInvoke, mockListen } = vi.hoisted(() => ({
  mockInvoke: vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>(() => Promise.resolve()),
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
} from "@/settings/bridge";

// recordHotkey is a thin invoke wrapper over the backend keytap recorder
// (hotkey::record_combination owns the capture state machine), so we only
// verify the IPC contract here.

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
    await deleteHistory("12345");
    expect(invoke).toHaveBeenCalledWith("delete_history", { ts: "12345" });
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

// ---- Hotkey recording ----

describe("settings bridge — recordHotkey", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("invokes the backend record_hotkey command and returns its result", async () => {
    // The backend (keytap) now owns capture, including keys the WebView never
    // sees as DOM events (e.g. Fn/Globe). The bridge is a thin invoke wrapper.
    const backendResult = { keys: ["Fn"], displayString: "Fn", hotkey: "Fn" };
    mockInvoke.mockResolvedValueOnce(backendResult);

    const result = await recordHotkey();

    expect(invoke).toHaveBeenCalledWith("record_hotkey");
    expect(result).toEqual(backendResult);
  });

  it("forwards an empty result when the user cancels (Escape / timeout)", async () => {
    mockInvoke.mockResolvedValueOnce({ keys: [], displayString: "", hotkey: undefined });

    const result = await recordHotkey();

    expect(result.keys).toEqual([]);
    expect(result.displayString).toBe("");
  });
});
