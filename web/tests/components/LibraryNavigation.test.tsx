import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadHotwords: vi.fn(),
  loadPrompts: vi.fn(),
  config: { app: { theme: "light" } },
}));
vi.mock("@/settings/bridge", () => mocks);
vi.mock("@/settings/SettingsProvider", () => ({
  SettingsProvider: ({ children }: { children: React.ReactNode }) => children,
  useSettings: () => ({ config: mocks.config, loading: false }),
}));
vi.mock("@/settings/hooks/useFeedback", () => ({ useFeedback: () => ({}) }));
vi.mock("@/settings/onboarding/useOnboarding", () => ({
  useOnboarding: () => ({ cancelTour: vi.fn() }),
}));
vi.mock("@/settings/layout/Sidebar", () => ({
  Sidebar: ({ onNavigate }: { onNavigate: (section: string) => void }) => (
    <nav>
      <button type="button" onClick={() => onNavigate("hotwords")}>
        hotwords
      </button>
      <button type="button" onClick={() => onNavigate("templates")}>
        templates
      </button>
    </nav>
  ),
}));
vi.mock("@/settings/pages/HomePage", () => ({ HomePage: () => null }));
vi.mock("@/settings/pages/AppSettingsPage", () => ({ AppSettingsPage: () => null }));
vi.mock("@/settings/pages/HotkeyPage", () => ({ HotkeyPage: () => null }));
vi.mock("@/settings/pages/models/ModelServicesPage", () => ({ ModelServicesPage: () => null }));
vi.mock("@/settings/pages/AboutPage", () => ({ AboutPage: () => null }));
vi.mock("@/settings/pages/FeedbackPage", () => ({ FeedbackPage: () => null }));

import { SettingsApp } from "@/settings/SettingsApp";

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("reserves library space while loading and preserves loaded rows across navigation", async () => {
  let resolveHotwords: (value: unknown) => void = () => {};
  let resolvePrompts: (value: unknown) => void = () => {};
  mocks.loadHotwords.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveHotwords = resolve;
      }),
  );
  mocks.loadPrompts.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolvePrompts = resolve;
      }),
  );
  const view = render(<SettingsApp />);
  fireEvent.click(screen.getByText("hotwords"));
  expect(view.container.querySelector('[aria-busy="true"]')).not.toBeNull();
  expect(screen.queryByText("添加")).not.toBeInTheDocument();
  await act(async () =>
    resolveHotwords({ active_group: "g", groups: [{ id: "g", name: "My words", words: [] }] }),
  );
  expect(screen.getByRole("button", { name: /My words/ })).toBeVisible();
  fireEvent.click(screen.getByText("templates"));
  expect(view.container.querySelector('[aria-busy="true"]')).not.toBeNull();
  await waitFor(() => expect(mocks.loadPrompts).toHaveBeenCalledTimes(1));
  await act(async () => resolvePrompts([{ id: "p", title: "My prompt", prompt: "Rewrite" }]));
  expect(screen.getByRole("button", { name: /My prompt/ })).toBeVisible();
  fireEvent.click(screen.getByText("hotwords"));
  expect(screen.getByRole("button", { name: /My words/ })).toBeVisible();
  expect(view.container.querySelector('[aria-busy="true"]')).toBeNull();
  expect(mocks.loadHotwords).toHaveBeenCalledTimes(1);
  expect(mocks.loadPrompts).toHaveBeenCalledTimes(1);
});

it("offers retry instead of an empty editable library when loading fails", async () => {
  mocks.loadHotwords
    .mockRejectedValueOnce(new Error("unavailable"))
    .mockResolvedValueOnce({ active_group: "", groups: [] });
  render(<SettingsApp />);
  fireEvent.click(screen.getByText("hotwords"));
  expect(await screen.findByRole("alert")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await act(async () => {});
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(mocks.loadHotwords).toHaveBeenCalledTimes(2);
});

it("refreshes cached templates after another settings page changes their hotkeys", async () => {
  mocks.loadPrompts.mockResolvedValueOnce([
    { id: "p", title: "Original", prompt: "Rewrite", hotkey: "" },
  ]);
  const view = render(<SettingsApp />);
  fireEvent.click(screen.getByText("templates"));
  expect(await screen.findByRole("button", { name: /Original/ })).toBeVisible();
  mocks.loadPrompts.mockResolvedValueOnce([
    { id: "p", title: "Updated elsewhere", prompt: "Rewrite", hotkey: "AltLeft" },
  ]);
  mocks.config = { app: { theme: "light" } };
  view.rerender(<SettingsApp />);
  expect(await screen.findByRole("button", { name: /Updated elsewhere/ })).toBeVisible();
  expect(mocks.loadPrompts).toHaveBeenCalledTimes(2);
});
