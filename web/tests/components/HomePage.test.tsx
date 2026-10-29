import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getStats: vi.fn(),
  getHistory: vi.fn(),
  getMicrophoneStatus: vi.fn(),
}));
vi.mock("@/settings/bridge", () => ({
  ...mocks,
  getAccessibilityStatus: async () => ({ status: "granted" }),
  onPreviewEnded: () => () => {},
}));
vi.mock("@/settings/SettingsProvider", () => ({
  useSettings: () => ({ settings: { runtime: { platform: "windows" } } }),
}));

import { HomePage } from "@/settings/pages/HomePage";

beforeEach(() => {
  mocks.getStats.mockResolvedValue({ totalCharacters: 120, totalSessions: 2, dailyCounts: {} });
  mocks.getHistory.mockResolvedValue([]);
  mocks.getMicrophoneStatus.mockResolvedValue({ status: "granted" });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("home loading and recovery", () => {
  it("does not show zero totals or empty history while requests are pending", async () => {
    let finishStats: (value: unknown) => void = () => {};
    let finishHistory: (value: unknown) => void = () => {};
    mocks.getStats.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishStats = resolve;
        }),
    );
    mocks.getHistory.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishHistory = resolve;
        }),
    );
    render(<HomePage />);
    expect(screen.queryByText("0", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText("暂无输入记录")).not.toBeInTheDocument();
    await act(async () => finishStats({ totalCharacters: 120, totalSessions: 2, dailyCounts: {} }));
    expect(screen.getByText("120", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText("暂无输入记录")).not.toBeInTheDocument();
    await act(async () => finishHistory([]));
    expect(screen.getByText("暂无输入记录")).toBeInTheDocument();
  });

  it("lets users retry failed statistics without hiding history", async () => {
    mocks.getStats.mockRejectedValueOnce(new Error("read failed"));
    render(<HomePage />);
    const alert = await screen.findByRole("alert");
    expect(await screen.findByText("暂无输入记录")).toBeInTheDocument();
    fireEvent.click(within(alert).getByRole("button", { name: "重试" }));
    expect(await screen.findByText("120", { exact: true })).toBeInTheDocument();
    expect(mocks.getStats).toHaveBeenCalledTimes(2);
  });

  it("keeps missing permissions discoverable after moving them out of navigation", async () => {
    mocks.getMicrophoneStatus.mockResolvedValue({ status: "denied" });
    const openSettings = vi.fn();
    render(<HomePage onOpenSettings={openSettings} />);
    fireEvent.click(await screen.findByRole("button", { name: "系统权限" }));
    expect(openSettings).toHaveBeenCalledOnce();
  });
});
