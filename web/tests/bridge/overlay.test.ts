import { describe, expect, it, vi } from "vitest";

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
  getConfig,
  notifyAudioStopped,
  onOverlayEvent,
  sendAudioChunk,
  sendAudioWarmupFailed,
  sendAudioWarmupReady,
  sendDiagnostic,
} from "@/bridge/overlay";

describe("overlay bridge", () => {
  describe("onOverlayEvent", () => {
    it("returns a cleanup function", () => {
      const cleanup = onOverlayEvent(() => {});
      expect(typeof cleanup).toBe("function");
    });

    it("calls listen with correct event name", () => {
      onOverlayEvent(() => {});
      expect(listen).toHaveBeenCalledWith("overlay:event", expect.any(Function));
    });

    it("cleanup calls the returned unlisten", async () => {
      const unlistenFn = vi.fn();
      vi.mocked(listen).mockResolvedValueOnce(unlistenFn);
      const cleanup = onOverlayEvent(() => {});
      cleanup();
      // Wait for the promise to resolve
      await vi.waitFor(() => {
        expect(unlistenFn).toHaveBeenCalled();
      });
    });
  });

  describe("sendAudioChunk", () => {
    it("invokes send_audio_chunk with base64Chunk", async () => {
      await sendAudioChunk("dGVzdA==");
      expect(invoke).toHaveBeenCalledWith("send_audio_chunk", { base64Chunk: "dGVzdA==" });
    });
  });

  describe("sendDiagnostic", () => {
    it("invokes send_diagnostic with payload", async () => {
      await sendDiagnostic({ info: "test" });
      expect(invoke).toHaveBeenCalledWith("send_diagnostic", { payload: { info: "test" } });
    });
  });

  describe("notifyAudioStopped", () => {
    it("invokes audio_stopped", async () => {
      await notifyAudioStopped();
      expect(invoke).toHaveBeenCalledWith("audio_stopped");
    });
  });

  describe("sendAudioWarmupReady", () => {
    it("invokes audio_warmup_ready", async () => {
      await sendAudioWarmupReady();
      expect(invoke).toHaveBeenCalledWith("audio_warmup_ready");
    });
  });

  describe("sendAudioWarmupFailed", () => {
    it("invokes audio_warmup_failed with message", async () => {
      await sendAudioWarmupFailed({ message: "test error" });
      expect(invoke).toHaveBeenCalledWith("audio_warmup_failed", {
        message: "test error",
      });
    });

    it("defaults message to empty string", async () => {
      await sendAudioWarmupFailed();
      expect(invoke).toHaveBeenCalledWith("audio_warmup_failed", { message: "" });
    });
  });

  describe("getConfig", () => {
    it("invokes get_app_config", async () => {
      await getConfig();
      expect(invoke).toHaveBeenCalledWith("get_app_config");
    });
  });
});
