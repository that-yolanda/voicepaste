import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getModelRegistry: vi.fn(),
  getDownloadedModels: vi.fn(),
  getAudioConfigDefaults: vi.fn(),
  loadPrompts: vi.fn(),
  settings: {
    parsedConfig: { app: { theme: "light", hotkey: "F13" } },
    runtime: { platform: "macos" },
  },
}));
vi.mock("@/settings/bridge", () => ({ ...mocks, onModelDownloadProgress: () => () => {} }));
vi.mock("@/settings/SettingsProvider", () => ({
  SettingsProvider: ({ children }: { children: React.ReactNode }) => children,
  useSettings: () => ({
    settings: mocks.settings,
    config: mocks.settings.parsedConfig,
    loading: false,
  }),
}));
vi.mock("@/settings/hooks/useFeedback", () => ({ useFeedback: () => ({}) }));
vi.mock("@/settings/onboarding/useOnboarding", () => ({
  useOnboarding: () => ({ cancelTour: vi.fn() }),
}));
vi.mock("@/settings/pages/HomePage", () => ({ HomePage: () => <p>Home contents</p> }));
vi.mock("@/settings/layout/Sidebar", () => ({
  Sidebar: ({ onNavigate }: { onNavigate: (id: string) => void }) => (
    <nav>
      {["home", "models", "hotkey"].map((id) => (
        <button key={id} type="button" onClick={() => onNavigate(id)}>
          {id}
        </button>
      ))}
    </nav>
  ),
}));

import { SettingsApp } from "@/settings/SettingsApp";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", () => ({ addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  mocks.getAudioConfigDefaults.mockResolvedValue(null);
  mocks.getDownloadedModels.mockResolvedValue([]);
  mocks.loadPrompts.mockImplementation(
    () => new Promise((resolve) => setTimeout(() => resolve([]), 25)),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
function modelsAfter(ms: number) {
  mocks.getModelRegistry.mockImplementation(
    () => new Promise((resolve) => setTimeout(() => resolve({ providers: [], models: [] }), ms)),
  );
}

it.each([
  "models",
  "hotkey",
])("keeps real controls mounted while %s data loads", async (destination) => {
  modelsAfter(25);
  const view = render(<SettingsApp />);
  const main = screen.getByRole("main");
  main.scrollTop = 400;
  fireEvent.click(screen.getByRole("button", { name: destination }));
  expect(screen.queryByText("Home contents")).not.toBeInTheDocument();
  expect(main.scrollTop).toBe(0);
  const control =
    destination === "models"
      ? screen.getByRole("combobox", { name: "语音识别" })
      : screen.getByRole("heading", { name: "全局语音主键" });
  expect(control).toBeVisible();
  expect(view.container.querySelector('[aria-busy="true"]')).toBeVisible();
  await advance(25);
  expect(control).toBeVisible();
  expect(control.isConnected).toBe(true);
  expect(view.container.querySelector('[aria-busy="true"]')).toBeNull();
});

it("does not navigate back when an unmounted page finishes reading", async () => {
  modelsAfter(300);
  render(<SettingsApp />);
  fireEvent.click(screen.getByRole("button", { name: "models" }));
  fireEvent.click(screen.getByRole("button", { name: "home" }));
  await advance(500);
  expect(screen.getByText("Home contents")).toBeVisible();
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
});
