import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AsrModelConfigDrawer } from "@/settings/components/models/ModelConfigDrawer";
import type { AsrDefaults } from "@/settings/lib/model";
import { ProviderDetailPage } from "@/settings/pages/models/ProviderDetailPage";
import type { RegistryModel, RegistryProvider } from "@/settings/types/models";
import registry from "../../../registry.json";

const mocks = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  save: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@/settings/SettingsProvider", () => ({
  useSettings: () => ({ settings: { parsedConfig: mocks.config }, refresh: mocks.refresh }),
}));
vi.mock("@/settings/bridge", () => ({
  saveConfigObject: mocks.save,
  deleteModel: vi.fn(),
  downloadModel: vi.fn(),
  testProviderConnection: vi.fn(),
}));
const models = registry.models as RegistryModel[];
const providers = registry.providers as RegistryProvider[];
const bytedance = providers.find((p) => p.id === "bytedance") as RegistryProvider;
const local = providers.find((p) => p.id === "local_asr") as RegistryProvider;
const vad = models.find((m) => m.id === "silero-vad") as RegistryModel;
const defaults = {
  ...registry.defaults.asr,
  vad: { ...registry.defaults.vad, threshold: 0.7 },
} as AsrDefaults;
function detail(provider: RegistryProvider) {
  return render(
    <ProviderDetailPage
      provider={provider}
      providers={providers}
      models={models}
      asrDefaults={defaults}
      downloaded={[vad.id]}
      downloadProgress={{}}
      onDownloadedChange={vi.fn()}
      onBack={vi.fn()}
    />,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.config = {
    audio: {
      provider: "",
      models: [],
      asr_defaults: {
        rate: 48000,
        num_threads: 7,
        vad: { threshold: 0.7, min_speech_duration: 0.3 },
      },
    },
  };
  mocks.refresh.mockResolvedValue(undefined);
});
afterEach(cleanup);

test("ByteDance uses separate URL controls even when its ASR preset is hidden", () => {
  detail(bytedance);
  expect(
    within(screen.getByRole("combobox")).getByRole("option", { name: "实时语音识别" }),
  ).toBeInTheDocument();
  fireEvent.change(screen.getByRole("combobox"), {
    target: { value: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async" },
  });
  expect(mocks.save.mock.calls.at(-1)?.[0].audio.credentials.bytedance.url).toContain(
    "bigmodel_async",
  );
  fireEvent.click(screen.getByRole("tab", { name: "大语言" }));
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  const url = screen.getByRole("textbox");
  fireEvent.change(url, { target: { value: "https://example.com/v1" } });
  fireEvent.blur(url);
  expect(mocks.save.mock.calls.at(-1)?.[0].llm.bytedance.url).toBe("https://example.com/v1");
});

test("Doubao resource ID remains editable in the model drawer", () => {
  const onConfigChange = vi.fn();
  render(
    <AsrModelConfigDrawer
      model={models.find((m) => m.id === "doubao-streaming") as RegistryModel}
      asrDefaults={null}
      userConfig={{}}
      onClose={vi.fn()}
      onConfigChange={onConfigChange}
      onReset={vi.fn()}
      onRemove={vi.fn()}
      removeLabel="remove"
    />,
  );
  const option = screen.getByRole("option", { name: /volc.seedasr.sauc.concurrent/ });
  fireEvent.change(option.closest("select") as HTMLSelectElement, {
    target: { value: "volc.seedasr.sauc.concurrent" },
  });
  expect(onConfigChange).toHaveBeenCalledWith("doubao-streaming", {
    resource_id: "volc.seedasr.sauc.concurrent",
  });
});

test("VAD reads shared values, writes there and resets without losing other defaults", async () => {
  detail(local);
  const row = screen.getByText("Silero VAD").closest(".flex.min-h-14") as HTMLElement;
  fireEvent.click(within(row).getByRole("button"));
  const threshold = screen
    .getAllByRole("spinbutton")
    .find((input) => (input as HTMLInputElement).value === "0.7") as HTMLElement;
  fireEvent.change(threshold, { target: { value: "0.6" } });
  fireEvent.blur(threshold);
  await waitFor(() => expect(mocks.save).toHaveBeenCalled());
  expect(mocks.save.mock.calls.at(-1)?.[0].audio.asr_defaults).toEqual({
    rate: 48000,
    num_threads: 7,
    vad: { threshold: 0.6, min_speech_duration: 0.3 },
  });
  fireEvent.click(screen.getByRole("button", { name: "恢复默认" }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(2));
  expect(mocks.save.mock.calls.at(-1)?.[0].audio.asr_defaults).toEqual({
    rate: 48000,
    num_threads: 7,
  });
});
