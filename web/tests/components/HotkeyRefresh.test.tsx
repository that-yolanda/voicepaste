import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getData: vi.fn(), saveConfigObject: vi.fn() }));
vi.mock("@/settings/bridge", () => ({
  ...mocks,
  loadPrompts: async () => [
    { id: "p", title: "Test template", hotkey: "ShiftLeft", hotkey_mode: "toggle" },
  ],
  savePrompts: async () => {},
  validateHotkeySettings: async () => {},
  getStats: async () => ({}),
  getHistory: async () => [],
  getMicrophoneStatus: async () => ({ status: "granted" }),
  onPreviewEnded: () => () => {},
}));
vi.mock("@/settings/layout/Sidebar", () => ({
  Sidebar: ({ onNavigate }: { onNavigate: (id: string) => void }) => (
    <button type="button" onClick={() => onNavigate("hotkey")}>
      open-hotkeys
    </button>
  ),
}));
vi.mock("@/settings/hooks/useFeedback", () => ({ useFeedback: () => ({ toast: null }) }));
vi.mock("@/settings/onboarding/useOnboarding", () => ({
  useOnboarding: () => ({ cancelTour: () => {}, guide: null, overlay: null }),
}));

import { SettingsApp } from "@/settings/SettingsApp";

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  mocks.getData.mockResolvedValue({
    parsedConfig: {
      app: { theme: "dark", hotkey: "F13", hotkey_mode: "toggle", voice_hotkey: "F2" },
    },
    runtime: { platform: "windows" },
  });
  mocks.saveConfigObject.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
it.each([0, 1])("keeps shortcut controls mounted while mode row %s refreshes", async (row) => {
  const view = render(<SettingsApp />);
  fireEvent.click(screen.getByText("open-hotkeys"));
  await screen.findByText("Test template");
  const page = view.container.querySelector('[data-tour="hotkey-main"]');
  let finishRefresh: (value: unknown) => void = () => {};
  mocks.getData.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishRefresh = resolve;
      }),
  );
  fireEvent.click(screen.getAllByRole("button", { name: "按住说话" })[row]);
  await waitFor(() => expect(mocks.getData).toHaveBeenCalledTimes(2));
  expect(view.container.querySelector('[data-tour="hotkey-main"]')).toBe(page);
  expect(view.container.querySelector('main [aria-hidden="true"].space-y-5')).toBeNull();
  await act(async () =>
    finishRefresh({
      parsedConfig: {
        app: {
          theme: "dark",
          hotkey: "F13",
          hotkey_mode: row === 0 ? "hold" : "toggle",
          voice_hotkey: "F2",
        },
      },
      runtime: { platform: "windows" },
    }),
  );
  expect(view.container.querySelector('[data-tour="hotkey-main"]')).toBe(page);
  expect(screen.getAllByRole("button", { name: "按住说话" })[row]).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});
