import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MicStatusResult } from "@/settings/bridge";

const mocks = vi.hoisted(() => ({
  getMicrophoneStatus: vi.fn(),
  getAccessibilityStatus: vi.fn(),
  requestMicrophoneAccess: vi.fn(),
}));
vi.mock("@/settings/SettingsProvider", () => ({
  useSettings: () => ({ settings: { runtime: { platform: "windows" } } }),
}));
vi.mock("@/settings/bridge", () => ({
  ...mocks,
  onEvent: () => () => {},
  openAccessibilitySettings: vi.fn(),
  reinitHotkey: vi.fn(),
}));

import { PermissionsPage } from "@/settings/pages/PermissionsPage";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getMicrophoneStatus.mockResolvedValue({ status: "granted" });
  mocks.getAccessibilityStatus.mockResolvedValue({ status: "granted" });
});
afterEach(cleanup);

async function mount() {
  render(<PermissionsPage />);
  await screen.findByText("已授权");
}

describe("microphone permission check feedback", () => {
  it("shows progress, blocks duplicate checks, and confirms an already granted permission", async () => {
    let finish: ((result: MicStatusResult) => void) | undefined;
    mocks.requestMicrophoneAccess.mockImplementation(
      () =>
        new Promise<MicStatusResult>((resolve) => {
          finish = resolve;
        }),
    );
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "检测" }));
    const pending = screen.getByRole("button", { name: "检测中…" });
    expect(pending).toBeDisabled();
    fireEvent.click(pending);
    expect(mocks.requestMicrophoneAccess).toHaveBeenCalledTimes(1);
    await act(async () => finish?.({ status: "granted", granted: true }));
    expect(screen.getByRole("status")).toHaveTextContent("检测完成：已授权");
    expect(screen.getByRole("button", { name: "检测" })).toBeEnabled();
  });

  it("uses the actual access result when the platform status query returns granted", async () => {
    mocks.requestMicrophoneAccess.mockResolvedValue({ status: "denied", granted: false });
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "检测" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("检测完成：已拒绝"));
    expect(screen.getByRole("button", { name: "检测" })).toBeEnabled();
  });

  it("shows a failure and allows retrying after an unexpected request error", async () => {
    mocks.requestMicrophoneAccess.mockRejectedValueOnce(new Error("device error"));
    mocks.requestMicrophoneAccess.mockResolvedValueOnce({ status: "granted", granted: true });
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "检测" }));
    await screen.findByText("检测失败，请重试");
    fireEvent.click(screen.getByRole("button", { name: "检测" }));
    await screen.findByText("检测完成：已授权");
  });
});
