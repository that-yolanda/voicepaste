import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ModelServicesPage } from "@/settings/pages/models/ModelServicesPage";
import type { RegistryModel } from "@/settings/types/models";
import registry from "../../../registry.json";

const mocks = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  downloaded: [] as string[],
  save: vi.fn(),
  refresh: vi.fn(),
  deleteModel: vi.fn(),
  downloadModel: vi.fn(),
  getDownloaded: vi.fn(),
}));
vi.mock("@/settings/SettingsProvider", () => ({
  useSettings: () => ({ settings: { parsedConfig: mocks.config }, refresh: mocks.refresh }),
}));
vi.mock("@/settings/bridge", () => ({
  saveConfigObject: mocks.save,
  deleteModel: mocks.deleteModel,
  downloadModel: mocks.downloadModel,
  getAudioConfigDefaults: vi.fn().mockResolvedValue(null),
  getDownloadedModels: mocks.getDownloaded,
  getModelRegistry: vi
    .fn()
    .mockImplementation(async () => (await import("../../../registry.json")).default),
  onModelDownloadProgress: vi.fn(() => () => {}),
}));
const localModel = (registry.models as RegistryModel[]).find(
  (m) => m.provider === "local_asr" && m.category === "asr",
) as RegistryModel;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.config = { audio: { provider: localModel.id }, llm: { provider: "bytedance" } };
  mocks.downloaded = [localModel.id];
  mocks.getDownloaded.mockImplementation(async () => [...mocks.downloaded]);
  mocks.deleteModel.mockImplementation(async () => {
    mocks.downloaded = [];
  });
  mocks.refresh.mockResolvedValue(undefined);
});
afterEach(cleanup);

test("deleting local files refreshes the row and removes the model from default choices", async () => {
  render(<ModelServicesPage />);
  const asr = await screen.findByRole("combobox", { name: "语音识别" });
  await waitFor(() =>
    expect(
      within(asr).getByRole("option", { name: new RegExp(localModel.name) }),
    ).toBeInTheDocument(),
  );
  fireEvent.click(screen.getByRole("button", { name: /本地语音识别模型/ }));
  fireEvent.click(screen.getByRole("button", { name: `配置 ${localModel.name}` }));
  fireEvent.click(screen.getByRole("button", { name: "删除模型文件" }));
  const download = await waitFor(() => {
    const updatedRow = screen
      .getByText(localModel.name, { exact: true })
      .closest(".group") as HTMLElement;
    return within(updatedRow).getByRole("button", { name: "下载" });
  });
  fireEvent.click(download);
  expect(mocks.downloadModel).toHaveBeenCalledWith(localModel.id);
  fireEvent.click(screen.getByRole("button", { name: /本地语音识别模型/ }));
  expect(
    within(screen.getByRole("combobox", { name: "语音识别" })).queryByRole("option", {
      name: new RegExp(localModel.name),
    }),
  ).not.toBeInTheDocument();
});

test("shows a migrated custom OpenAI default and preserves an explicitly empty ASR default", async () => {
  mocks.config = {
    audio: { provider: "" },
    llm: { provider: "openai_compatible", openai_compatible: { model: "my-legacy-model" } },
  };
  render(<ModelServicesPage />);
  const llm = await screen.findByRole("combobox", { name: "大语言" });
  await waitFor(() => expect(llm).toHaveValue("custom_openai::my-legacy-model"));
  expect(screen.getByRole("combobox", { name: "语音识别" })).not.toHaveValue("doubao-streaming");
});

test("uses the backend default provider when the saved provider is omitted", async () => {
  mocks.config = {
    llm: {
      default_model: "doubao-seed-1-6-flash",
      bytedance: { models: [{ id: "doubao-seed-1-6-flash" }] },
    },
  };
  render(<ModelServicesPage />);
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "大语言" })).toHaveValue(
      "bytedance::doubao-seed-1-6-flash",
    ),
  );
});

test("failed default save shows an error without reporting success", async () => {
  mocks.save.mockRejectedValueOnce({
    code: "asr.config_field_invalid",
    params: { field: "audio.qwen-asr-streaming.language_hints" },
  });
  render(<ModelServicesPage />);
  const asr = await screen.findByRole("combobox", { name: "语音识别" });
  fireEvent.change(asr, { target: { value: "" } });
  expect(await screen.findByText(/audio.qwen-asr-streaming.language_hints/)).toBeInTheDocument();
  expect(mocks.refresh).not.toHaveBeenCalled();
});

test("failed provider save keeps the catalog open and does not navigate", async () => {
  mocks.config = { model_providers: { added: ["local_asr"] }, audio: { provider: localModel.id } };
  mocks.save.mockRejectedValueOnce("Cannot save settings");
  render(<ModelServicesPage />);
  await screen.findByRole("combobox", { name: "语音识别" });
  fireEvent.click(await screen.findByRole("button", { name: /显示其余/ }));
  fireEvent.click(await screen.findByRole("button", { name: /DeepSeek/ }));
  expect(await screen.findByText("Cannot save settings")).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "收起" })).toHaveAttribute("aria-expanded", "true");
  expect(mocks.refresh).not.toHaveBeenCalled();
});

test("provider editing and the inline catalog are mutually exclusive", async () => {
  mocks.config = {
    model_providers: { added: ["bytedance", "local_asr"] },
    audio: { provider: localModel.id },
  };
  render(<ModelServicesPage />);
  const doubao = await screen.findByRole("button", { name: /^字节跳动/ });
  const local = screen.getByRole("button", { name: /本地语音识别模型/ });
  fireEvent.click(doubao);
  expect(doubao).toHaveAttribute("aria-expanded", "true");
  fireEvent.click(local);
  expect(doubao).toHaveAttribute("aria-expanded", "false");
  expect(document.getElementById("provider-panel-bytedance")).toHaveAttribute("inert");
  expect(local).toHaveAttribute("aria-expanded", "true");
  fireEvent.click(screen.getByRole("button", { name: /显示其余/ }));
  expect(local).toHaveAttribute("aria-expanded", "false");
  expect(document.getElementById("provider-catalog")).not.toHaveAttribute("inert");
  fireEvent.click(doubao);
  expect(document.getElementById("provider-catalog")).toHaveAttribute("inert");
  expect(doubao).toHaveAttribute("aria-expanded", "true");
});

test("adding an inline provider saves it, closes the catalog and opens its editor", async () => {
  mocks.config = { model_providers: { added: ["local_asr"] }, audio: { provider: localModel.id } };
  const view = render(<ModelServicesPage />);
  mocks.save.mockImplementationOnce(async (config) => {
    mocks.config = config;
  });
  mocks.refresh.mockImplementationOnce(async () => {
    view.rerender(<ModelServicesPage />);
  });
  fireEvent.click(await screen.findByRole("button", { name: /显示其余/ }));
  fireEvent.click(await screen.findByRole("button", { name: /DeepSeek/ }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /^DeepSeek/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    ),
  );
  expect(mocks.save.mock.calls.at(-1)?.[0].model_providers.added).toContain("deepseek");
  expect(document.getElementById("provider-catalog")).toHaveAttribute("inert");
  expect(await screen.findByRole("region", { name: "DeepSeek" })).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
