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
import { onOverlayEvent, retryLatestFailedTranscription } from "@/overlay/bridge";

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

  describe("retryLatestFailedTranscription", () => {
    it("invokes retry_latest_failed_transcription", async () => {
      await retryLatestFailedTranscription();
      expect(invoke).toHaveBeenCalledWith("retry_latest_failed_transcription");
    });
  });
});
