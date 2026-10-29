import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  installUpdate: vi.fn(),
  onUpdateProgress: vi.fn(),
  openHelpGuide: vi.fn(),
}));
vi.mock("@/settings/bridge", () => mocks);
vi.mock("@/settings/SettingsProvider", () => ({
  useSettings: () => ({ settings: { runtime: { version: "2.1.5" } } }),
}));

import { Sidebar } from "@/settings/layout/Sidebar";
import { AboutPage } from "@/settings/pages/AboutPage";

afterEach(cleanup);

it("keeps the current version visible through checking, downloading, installation and retry", async () => {
  mocks.checkForUpdates.mockResolvedValue({ available: true, version: "2.1.6" });
  let finishDownload: () => void = () => {};
  mocks.downloadUpdate.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finishDownload = resolve;
      }),
  );
  const unsubscribe = vi.fn();
  mocks.onUpdateProgress.mockReturnValue(unsubscribe);
  mocks.installUpdate.mockRejectedValue(new Error("relaunch failed"));
  const navigate = vi.fn();
  render(<Sidebar active="home" onNavigate={navigate} />);
  fireEvent.click(screen.getByText("设置", { exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "通用设置" }));
  expect(navigate).toHaveBeenCalledWith("app");
  expect(screen.getByText("v2.1.5")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "正在检查" })).not.toBeInTheDocument();
  const download = await screen.findByRole("button", { name: "更新" });
  expect(download.querySelector(".lucide-arrow-up")).not.toBeNull();
  expect(download).toHaveTextContent("更新");
  expect(download).toHaveAttribute("title", "新版本 2.1.6 可用");
  fireEvent.click(download);
  expect(screen.getByRole("button", { name: "下载中…" })).toBeDisabled();
  act(() => mocks.onUpdateProgress.mock.calls[0][0]({ downloaded: 50, contentLength: 100 }));
  expect(screen.getByRole("button", { name: "50%" })).toHaveAttribute("title", "下载中 50%");
  await act(async () => finishDownload());
  fireEvent.click(await screen.findByRole("button", { name: "重启安装" }));
  const retry = await screen.findByRole("button", { name: "重试" });
  expect(mocks.installUpdate).toHaveBeenCalledOnce();
  expect(unsubscribe).toHaveBeenCalledOnce();
  mocks.checkForUpdates.mockResolvedValue({ available: false });
  fireEvent.click(retry);
  await waitFor(() => expect(mocks.checkForUpdates).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "重试" })).not.toBeInTheDocument(),
  );
  expect(screen.queryByRole("button", { name: "检查更新" })).not.toBeInTheDocument();
  render(<AboutPage />);
  expect(screen.getByText("2.1.5", { exact: true })).toBeInTheDocument();
  expect(screen.getByText("已是最新版本")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "检查更新" })).toBeInTheDocument();
  expect(screen.getByText("v2.1.5")).toBeInTheDocument();
  expect(mocks.checkForUpdates).toHaveBeenCalledTimes(2);
});
