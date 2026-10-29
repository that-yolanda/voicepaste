import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MicStatusResult } from "@/settings/bridge";

const mocks = vi.hoisted(() => ({
  getMicrophoneStatus: vi.fn(),
  getAccessibilityStatus: vi.fn(),
  requestMicrophoneAccess: vi.fn(),
  openMicrophoneSettings: vi.fn(),
  openAccessibilitySettings: vi.fn(),
  reinitHotkey: vi.fn(),
  platform: "windows",
}));
vi.mock("@/settings/SettingsProvider", () => ({
  useSettings: () => ({ settings: { runtime: { platform: mocks.platform } } }),
}));
vi.mock("@/settings/bridge", () => mocks);

import { PermissionsPage } from "@/settings/pages/PermissionsPage";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.platform = "windows";
  mocks.getMicrophoneStatus.mockResolvedValue({ status: "granted" });
  mocks.getAccessibilityStatus.mockResolvedValue({ status: "denied" });
  mocks.reinitHotkey.mockResolvedValue({ active: true });
});
afterEach(cleanup);

async function mount() {
  render(<PermissionsPage />);
  await waitFor(() => expect(screen.getByRole("button", { name: "检测" })).toBeEnabled());
}

describe("native permission controls", () => {
  it("shows the existing green CircleCheck style with an accessible label", async () => {
    await mount();
    expect(screen.getByText("已授权")).toHaveClass("sr-only");
    expect(document.querySelector(".lucide-circle-check")).toHaveClass(
      "fill-success",
      "text-surface",
    );
    expect(screen.getByRole("button", { name: "前往设置" })).toBeEnabled();
  });

  it("only offers Allow for a confirmed first request, without an extra hint", async () => {
    mocks.getMicrophoneStatus.mockResolvedValue({ status: "prompt" });
    render(<PermissionsPage />);
    const allow = await screen.findByRole("button", { name: "授权" });
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    mocks.requestMicrophoneAccess.mockResolvedValue({ status: "denied", granted: false });
    fireEvent.click(allow);
    await screen.findByText("权限已禁用。请在设置中开启。");
    expect(screen.getByRole("button", { name: "检测" })).toBeEnabled();
  });

  it("blocks duplicate requests and keeps the actual result instead of overwriting it", async () => {
    let finish: ((result: MicStatusResult) => void) | undefined;
    mocks.requestMicrophoneAccess.mockImplementation(
      () =>
        new Promise<MicStatusResult>((resolve) => {
          finish = resolve;
        }),
    );
    await mount();
    const button = screen.getByRole("button", { name: "检测" });
    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(screen.getByRole("button", { name: "前往设置" })).toBeDisabled();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    fireEvent.click(button);
    expect(mocks.requestMicrophoneAccess).toHaveBeenCalledTimes(1);
    await act(async () => finish?.({ status: "denied", granted: false }));
    await screen.findByText("权限已禁用。请在设置中开启。");
    expect(mocks.getMicrophoneStatus).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["restricted", "权限受限。请联系管理员。"],
    ["unknown", "检测失败。请重试。"],
    ["no_device", "未找到麦克风。请设置默认输入设备。"],
    ["unavailable", "麦克风不可用。请检查设备。"],
  ])("keeps %s distinct from a refusal", async (status, hint) => {
    mocks.getMicrophoneStatus.mockResolvedValue({ status });
    await mount();
    expect(screen.getByRole("status")).toHaveTextContent(hint);
  });

  it("handles unexpected errors and allows another check", async () => {
    mocks.requestMicrophoneAccess.mockRejectedValueOnce(new Error("IPC failed"));
    mocks.requestMicrophoneAccess.mockResolvedValueOnce({ status: "granted", granted: true });
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "检测" }));
    await screen.findByText("检测失败。请重试。");
    fireEvent.click(screen.getByRole("button", { name: "检测" }));
    await screen.findByText("已授权");
  });

  it("refreshes both permissions on focus and restores the hotkey after granting accessibility", async () => {
    mocks.platform = "macos";
    render(<PermissionsPage />);
    await screen.findByText("权限已禁用。请在设置中开启。");
    expect(mocks.reinitHotkey).not.toHaveBeenCalled();
    mocks.getAccessibilityStatus.mockResolvedValue({ status: "granted" });
    mocks.getMicrophoneStatus.mockResolvedValue({ status: "denied" });
    fireEvent.focus(window);
    await waitFor(() => expect(mocks.reinitHotkey).toHaveBeenCalledTimes(1));
    expect(mocks.getMicrophoneStatus).toHaveBeenCalledTimes(2);
    expect(screen.getAllByRole("status")[1]).toHaveTextContent("权限已禁用。请在设置中开启。");
    expect(within(screen.getAllByRole("status")[0]).getByText("已授权")).toBeInTheDocument();
  });

  it("opens the microphone page and reports navigation errors", async () => {
    mocks.openMicrophoneSettings.mockRejectedValue(new Error("navigation failed"));
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "前往设置" }));
    await screen.findByText("无法打开设置");
    expect(mocks.openMicrophoneSettings).toHaveBeenCalledTimes(1);
  });

  it("routes accessibility settings through its native prompt/settings command", async () => {
    mocks.platform = "macos";
    render(<PermissionsPage />);
    await screen.findByText("权限已禁用。请在设置中开启。");
    fireEvent.click(screen.getAllByRole("button", { name: "前往设置" })[0]);
    await waitFor(() => expect(mocks.openAccessibilitySettings).toHaveBeenCalledTimes(1));
    expect(mocks.openMicrophoneSettings).not.toHaveBeenCalled();
  });
});
