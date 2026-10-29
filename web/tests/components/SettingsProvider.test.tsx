import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettingsData } from "@/settings/bridge";

const mocks = vi.hoisted(() => ({ getData: vi.fn(), saveConfigObject: vi.fn() }));
vi.mock("@/settings/bridge", () => mocks);

import { SettingsProvider, useSettings } from "@/settings/SettingsProvider";

function Harness() {
  const { loading, error, config, refresh, scheduleSave } = useSettings();
  return (
    <>
      <p>{loading ? "loading" : error ? "error" : config?.app?.theme}</p>
      <button type="button" onClick={() => void refresh()}>
        retry
      </button>
      <button type="button" onClick={() => void scheduleSave({ app: { theme: "dark" } })}>
        save
      </button>
    </>
  );
}
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("settings initialization", () => {
  it("keeps loading visible until configuration arrives", async () => {
    let resolve: (data: SettingsData) => void = () => {};
    mocks.getData.mockImplementation(
      () =>
        new Promise<SettingsData>((done) => {
          resolve = done;
        }),
    );
    render(
      <SettingsProvider>
        <Harness />
      </SettingsProvider>,
    );
    expect(screen.getByText("loading")).toBeInTheDocument();
    await act(async () => resolve({ parsedConfig: { app: { theme: "light" } } }));
    expect(screen.getByText("light")).toBeInTheDocument();
  });

  it("retries a failed initial read and preserves other settings on save", async () => {
    mocks.getData.mockRejectedValueOnce(new Error("IPC unavailable"));
    render(
      <SettingsProvider>
        <Harness />
      </SettingsProvider>,
    );
    await screen.findByText("error");
    mocks.getData.mockResolvedValue({ parsedConfig: { app: { theme: "light", language: "en" } } });
    fireEvent.click(screen.getByText("retry"));
    await screen.findByText("light");
    mocks.saveConfigObject.mockResolvedValue(undefined);
    fireEvent.click(screen.getByText("save"));
    await waitFor(() =>
      expect(mocks.saveConfigObject).toHaveBeenCalledWith({
        app: { theme: "dark", language: "en" },
      }),
    );
  });
});
