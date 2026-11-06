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
  testProviderConnection: vi.fn(),
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
  const name = screen.getByText(localModel.name, { exact: true });
  const row = name.closest(".flex.min-h-14") as HTMLElement;
  fireEvent.click(within(row).getByRole("button"));
  fireEvent.click(screen.getByRole("button", { name: "删除模型文件" }));
  await waitFor(() =>
    expect(within(row).getByRole("button", { name: "下载" })).toBeInTheDocument(),
  );
  fireEvent.click(within(row).getByRole("button", { name: "下载" }));
  expect(mocks.downloadModel).toHaveBeenCalledWith(localModel.id);
  fireEvent.click(screen.getByRole("button", { name: "模型服务" }));
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
  mocks.config = { llm: { default_model: "doubao-seed-1-6-flash" } };
  render(<ModelServicesPage />);
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "大语言" })).toHaveValue(
      "bytedance::doubao-seed-1-6-flash",
    ),
  );
});
