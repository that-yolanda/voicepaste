import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AsrModelConfigModal } from "@/settings/components/models/ModelConfigModal";
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

test("ByteDance exposes distinct ASR and LLM addresses with their defaults", () => {
  detail(bytedance);
  const url = screen.getByRole("textbox");
  expect(url).toHaveValue("wss://openspeech.bytedance.com/api/v3/sauc");
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  fireEvent.change(url, { target: { value: "wss://example.com/sauc" } });
  fireEvent.blur(url);
  expect(mocks.save.mock.calls.at(-1)?.[0].audio.credentials.bytedance.url_base).toBe(
    "wss://example.com/sauc",
  );
  fireEvent.click(screen.getByRole("tab", { name: "大语言" }));
  const llmUrl = screen.getByRole("textbox");
  expect(llmUrl).toHaveValue("https://ark.cn-beijing.volces.com/api/v3/chat/completions");
  fireEvent.change(llmUrl, { target: { value: "https://example.com/v1" } });
  fireEvent.blur(llmUrl);
  expect(mocks.save.mock.calls.at(-1)?.[0].llm.bytedance.url).toBe("https://example.com/v1");
});

test("changing recognition mode migrates a legacy custom URL without losing its prefix", () => {
  mocks.config = {
    audio: {
      provider: "doubao-streaming",
      models: ["doubao-streaming"],
      credentials: { bytedance: { url: "wss://example.test/sauc/bigmodel_nostream" } },
    },
  };
  detail(bytedance);
  expect(screen.getByRole("textbox")).toHaveValue("wss://example.test/sauc");
  fireEvent.click(screen.getByRole("button", { name: /配置 豆包/ }));
  const mode = screen.getByRole("combobox", { name: "识别方式" });
  expect(mode).toHaveValue("wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream");
  fireEvent.change(mode, {
    target: { value: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async" },
  });
  const audio = mocks.save.mock.calls.at(-1)?.[0].audio;
  expect(audio.credentials.bytedance.url_base).toBe("wss://example.test/sauc");
  expect(audio.credentials.bytedance.url).toBeUndefined();
  expect(audio["doubao-streaming"].url).toContain("bigmodel_async");
});

test("Doubao resource ID remains editable in the model modelModal", () => {
  const onConfigChange = vi.fn();
  render(
    <AsrModelConfigModal
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
  fireEvent.click(row);
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
