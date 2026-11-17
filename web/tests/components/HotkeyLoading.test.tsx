import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { HotkeyPage } from "@/settings/pages/HotkeyPage";

const mocks = vi.hoisted(() => ({ loadPrompts: vi.fn() }));
vi.mock("@/settings/bridge", () => mocks);
vi.mock("@/settings/SettingsProvider", () => ({
  useSettings: () => ({ settings: { parsedConfig: { app: { hotkey: "F13" } } } }),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("shows placeholders rather than an empty-template message while shortcuts load", async () => {
  let finish: (value: unknown[]) => void = () => {};
  mocks.loadPrompts.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(<HotkeyPage />);
  expect(view.container.querySelector('[aria-busy="true"]')).not.toBeNull();
  expect(screen.getByRole("heading", { name: "全局语音主键" })).toBeVisible();
  expect(screen.getByText("语音输入")).toBeVisible();
  const fields = screen.getAllByRole("button", { name: "快捷键" });
  expect(fields.some((field) => !field.hasAttribute("disabled"))).toBe(true);
  const globalKey = fields[0];
  await act(async () => finish([{ id: "p", title: "Loaded template", hotkey: "F2" }]));
  expect(globalKey.isConnected).toBe(true);
  expect(screen.getByText("Loaded template")).toBeVisible();
  expect(view.container.querySelector('[aria-busy="true"]')).toBeNull();
});

it("allows retry after the initial shortcut read fails", async () => {
  mocks.loadPrompts.mockRejectedValueOnce(new Error("unavailable")).mockResolvedValueOnce([]);
  render(<HotkeyPage />);
  expect(await screen.findByRole("alert")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await act(async () => {});
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(mocks.loadPrompts).toHaveBeenCalledTimes(2);
});
