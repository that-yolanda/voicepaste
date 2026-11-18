import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { getAudioConfigDefaults, getModelRegistry } from "@/settings/bridge";
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

test("keeps the first LLM candidate unselected until the user sets it as default", async () => {
  const model = "deepseek-v4-flash";
  const value = `deepseek::${model}`;
  const initialLlm = {
    provider: "bytedance",
    bytedance: { models: [] },
    deepseek: { models: [{ id: model }] },
  };
  mocks.config = {
    model_providers: { added: ["bytedance", "deepseek"] },
    llm: initialLlm,
  };
  const view = render(<ModelServicesPage />);
  const llm = screen.getByRole<HTMLSelectElement>("combobox", { name: "大语言" });
  await waitFor(() => expect(llm).toBeEnabled());
  expect(Array.from(llm.options, (option) => option.value)).toEqual(["", value]);
  expect(llm).toHaveValue("");
  expect(mocks.save).not.toHaveBeenCalled();

  fireEvent.change(llm, { target: { value } });
  expect(mocks.save).toHaveBeenCalledExactlyOnceWith({
    ...mocks.config,
    llm: { ...initialLlm, provider: "deepseek", default_model: model },
  });
  await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
  mocks.config = mocks.save.mock.calls[0][0];
  view.rerender(<ModelServicesPage />);
  expect(llm).toHaveValue(value);
});

test("keeps the existing LLM default when another provider gets a model", async () => {
  const activeLlm = {
    provider: "bytedance",
    default_model: "doubao-seed-1-6-flash",
    bytedance: { models: [{ id: "doubao-seed-1-6-flash" }] },
  };
  mocks.config = {
    model_providers: { added: ["deepseek", "bytedance"] },
    llm: { ...activeLlm, deepseek: { models: [] } },
  };
  const view = render(<ModelServicesPage />);
  const llm = screen.getByRole<HTMLSelectElement>("combobox", { name: "大语言" });
  await waitFor(() => expect(llm).toHaveValue("bytedance::doubao-seed-1-6-flash"));

  mocks.config = {
    ...mocks.config,
    llm: { ...activeLlm, deepseek: { models: [{ id: "deepseek-v4-flash" }] } },
  };
  view.rerender(<ModelServicesPage />);
  expect(Array.from(llm.options, (option) => option.value)).toContain(
    "deepseek::deepseek-v4-flash",
  );
  expect(llm).toHaveValue("bytedance::doubao-seed-1-6-flash");
  expect(mocks.save).not.toHaveBeenCalled();
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
  const doubao = await screen.findByRole("button", { name: /^火山引擎/ });
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

test("fresh installs show only Add Provider and adding one does not seed models", async () => {
  mocks.config = {
    model_providers: { added: [] },
    audio: { provider: "", models: [] },
    llm: { provider: "" },
  };
  const providerName = registry.providers.find((provider) => provider.id === "bytedance")?.name;
  expect(providerName).toBeTruthy();
  const view = render(<ModelServicesPage />);
  mocks.save.mockImplementationOnce(async (config) => {
    mocks.config = config;
  });
  mocks.refresh.mockImplementationOnce(async () => {
    view.rerender(<ModelServicesPage />);
  });
  const add = await waitFor(() => {
    const button = screen.getByRole("button", { name: "添加供应商" });
    expect(button).toBeEnabled();
    return button;
  });
  expect(add.closest('[data-tour="models-add-provider"]')).toContainElement(add);
  expect(add).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("button", { name: new RegExp(`^${providerName}`) })).toBeNull();
  expect(screen.getByRole("combobox", { name: "语音识别" })).toHaveValue("");
  expect(document.querySelector('[data-tour="models-default-asr"]')).toContainElement(
    screen.getByRole("combobox", { name: "语音识别" }),
  );
  expect(document.querySelector('[data-tour="models-default-llm"]')).toContainElement(
    screen.getByRole("combobox", { name: "大语言" }),
  );
  expect(screen.getByRole("combobox", { name: "大语言" })).toHaveValue("");
  fireEvent.click(add);
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(`^${providerName}`) }));
  await screen.findByRole("tab", { name: "语音识别" });
  expect(mocks.save.mock.calls.at(-1)?.[0]).toMatchObject({
    model_providers: { added: ["bytedance"] },
    audio: { models: [] },
    llm: { bytedance: { models: [] } },
  });
  expect(screen.queryByRole("button", { name: /^配置 / })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "大语言" }));
  expect(screen.getByText("暂无模型，点击「添加模型」加入")).toBeInTheDocument();
});

test("keeps real model selectors mounted until all dependencies are ready", async () => {
  let finishRegistry: (value: typeof registry) => void = () => {};
  let finishDefaults: (value: Record<string, unknown>) => void = () => {};
  let finishDownloaded: (value: string[]) => void = () => {};
  vi.mocked(getModelRegistry).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishRegistry = resolve;
      }),
  );
  vi.mocked(getAudioConfigDefaults).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishDefaults = resolve;
      }),
  );
  mocks.getDownloaded.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishDownloaded = resolve;
      }),
  );
  const view = render(<ModelServicesPage />);
  expect(view.container.querySelector('[aria-busy="true"]')).not.toBeNull();
  expect(screen.getByRole("combobox", { name: "语音识别" })).toBeVisible();
  await act(async () => finishRegistry(registry));
  await act(async () => finishDefaults({ ...registry.defaults.asr, vad: registry.defaults.vad }));
  expect(screen.getByRole("combobox", { name: "语音识别" })).toBeVisible();
  await act(async () => finishDownloaded([localModel.id]));
  expect(screen.getByRole("combobox", { name: "语音识别" })).toHaveValue(localModel.id);
  expect(view.container.querySelector('[aria-busy="true"]')).toBeNull();
});

test("replaces a failed initial registry read with retry instead of empty model choices", async () => {
  vi.mocked(getModelRegistry).mockRejectedValueOnce(new Error("unavailable"));
  render(<ModelServicesPage />);
  const alert = await screen.findByRole("alert");
  expect(screen.getByRole("combobox", { name: "语音识别" })).toBeVisible();
  fireEvent.click(within(alert).getByRole("button", { name: "重试" }));
  expect(await screen.findByRole("combobox", { name: "语音识别" })).toBeVisible();
});
