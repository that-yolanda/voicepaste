import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  listModels: vi.fn(),
  testModel: vi.fn(),
  cancelTest: vi.fn(),
}));
vi.mock("@/settings/SettingsProvider", () => ({
  useSettings: () => ({ settings: { parsedConfig: mocks.config }, refresh: mocks.refresh }),
}));
vi.mock("@/settings/bridge", () => ({
  saveConfigObject: mocks.save,
  deleteModel: vi.fn(),
  downloadModel: vi.fn(),
  listLlmModels: mocks.listModels,
  testModel: mocks.testModel,
  cancelModelTest: mocks.cancelTest,
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
  mocks.listModels.mockReset();
  mocks.listModels.mockResolvedValue({ data: [{ id: "model-a" }] });
  mocks.testModel.mockResolvedValue({ output: "Hello", elapsed_ms: 1000 });
  mocks.cancelTest.mockResolvedValue(undefined);
});
afterEach(cleanup);

test("model header sets both LLM provider and model without a close icon", () => {
  mocks.config.llm = { provider: "deepseek", bytedance: { models: [{ id: "chosen" }] } };
  detail(bytedance);
  fireEvent.click(screen.getByRole("tab", { name: "大语言" }));
  fireEvent.click(screen.getByRole("button", { name: "配置 chosen" }));
  const dialog = within(screen.getByRole("dialog"));
  expect(dialog.queryByRole("button", { name: "Close modal" })).not.toBeInTheDocument();
  expect(
    dialog
      .getByRole("button", { name: "移除" })
      .compareDocumentPosition(dialog.getByRole("button", { name: "设为默认" })) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  fireEvent.click(dialog.getByRole("button", { name: "设为默认" }));
  expect(mocks.save.mock.calls.at(-1)?.[0].llm).toMatchObject({
    provider: "bytedance",
    default_model: "chosen",
  });
});

test("model ID help opens a toast and redundant model hints are absent", () => {
  mocks.config.llm = { provider: "bytedance", bytedance: { models: [{ id: "chosen" }] } };
  detail(bytedance);
  fireEvent.click(screen.getByRole("tab", { name: "大语言" }));
  fireEvent.click(screen.getByRole("button", { name: "配置 chosen" }));
  const description = "实际请求的模型标识；留空使用预置值。";
  expect(screen.queryByText(description)).not.toBeInTheDocument();
  expect(screen.queryByText("推理参数")).not.toBeInTheDocument();
  expect(screen.queryByText(/仅显式设置的参数/)).not.toBeInTheDocument();
  const help = screen.getByRole("button", { name: "Model ID说明" });
  expect(
    screen.getByText("Model ID", { exact: true }).closest(".section-item-label"),
  ).toContainElement(help);
  expect(
    screen.getByRole("textbox", { name: "Model ID" }).closest(".section-item-action"),
  ).not.toContainElement(help);
  fireEvent.click(help);
  expect(screen.getByRole("dialog")).not.toContainElement(screen.getByText(description));
});

test("other dialogs close through the backdrop without a header close button", () => {
  detail(bytedance);
  fireEvent.click(screen.getByRole("button", { name: "添加模型" }));
  expect(
    within(screen.getByRole("dialog")).queryByRole("button", { name: "Close modal" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Close modal" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("ASR can be selected in its dialog while undownloaded models cannot be selected or tested", () => {
  mocks.config.audio = { provider: "elevenlabs-realtime", models: ["doubao-streaming"] };
  detail(bytedance);
  fireEvent.click(screen.getByRole("button", { name: /配置 豆包/ }));
  fireEvent.click(screen.getByRole("button", { name: "设为默认" }));
  expect(mocks.save.mock.calls.at(-1)?.[0].audio.provider).toBe("doubao-streaming");
  cleanup();
  const model = models.find(
    (m) => m.provider === "local_asr" && m.category === "asr",
  ) as RegistryModel;
  render(
    <AsrModelConfigModal
      model={model}
      asrDefaults={defaults}
      userConfig={{}}
      onClose={vi.fn()}
      onConfigChange={vi.fn()}
      onReset={vi.fn()}
      onRemove={vi.fn()}
      removeLabel="移除"
      onSetDefault={vi.fn()}
      defaultDisabled
      testTarget={{
        providerId: "local_asr",
        modelId: model.id,
        capability: "asr",
        getConfig: () => mocks.config,
        showToast: vi.fn(),
        disabled: true,
      }}
    />,
  );
  expect(screen.getByRole("button", { name: "设为默认" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "测试" })).toBeDisabled();
});

test("LLM test uses the latest edited model snapshot without switching the active model", async () => {
  mocks.config.llm = { provider: "deepseek", bytedance: { models: [{ id: "chosen" }] } };
  detail(bytedance);
  fireEvent.click(screen.getByRole("tab", { name: "大语言" }));
  fireEvent.click(screen.getByRole("button", { name: "配置 chosen" }));
  const id = screen.getByRole("textbox", { name: "Model ID" });
  fireEvent.change(id, { target: { value: "actual-request-model" } });
  fireEvent.blur(id);
  const testButton = screen.getByRole("button", { name: "测试" });
  expect(
    within(screen.getByRole("dialog"))
      .getByRole("button", { name: "移除" })
      .compareDocumentPosition(testButton) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  fireEvent.click(testButton);
  const result = await screen.findByText("模型请求成功");
  expect(screen.queryByText("Hello")).not.toBeInTheDocument();
  expect(screen.getByRole("dialog")).not.toContainElement(result);
  expect(mocks.testModel).toHaveBeenCalledWith(
    expect.objectContaining({
      llm: expect.objectContaining({
        provider: "deepseek",
        bytedance: expect.objectContaining({
          models: [expect.objectContaining({ id: "chosen", model_id: "actual-request-model" })],
        }),
      }),
    }),
    "bytedance",
    "chosen",
    "llm",
    expect.any(String),
  );
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

test("model test failures appear in a toast outside the dialog", async () => {
  mocks.testModel.mockRejectedValueOnce(new Error("test connection failed"));
  mocks.config.audio = { provider: "doubao-streaming", models: ["doubao-streaming"] };
  detail(bytedance);
  fireEvent.click(screen.getByRole("button", { name: /配置 豆包/ }));
  fireEvent.click(screen.getByRole("button", { name: "测试" }));
  const error = await screen.findByText(/test connection failed/);
  expect(screen.getByRole("dialog")).not.toContainElement(error);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

test("closing a model dialog cancels its pending test and ignores late results", async () => {
  let finish!: (result: { output: string; elapsed_ms: number }) => void;
  mocks.testModel.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  mocks.config.audio = { provider: "doubao-streaming", models: ["doubao-streaming"] };
  detail(bytedance);
  fireEvent.click(screen.getByRole("button", { name: /配置 豆包/ }));
  const dialog = within(screen.getByRole("dialog"));
  expect(dialog.queryByRole("button", { name: "当前使用" })).not.toBeInTheDocument();
  expect(dialog.getByText("当前使用")).toHaveClass("text-accent");
  fireEvent.click(screen.getByRole("button", { name: "测试" }));
  expect(screen.getByRole("button", { name: "测试中…" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(mocks.cancelTest).toHaveBeenCalledWith(mocks.testModel.mock.calls.at(-1)?.[4]);
  finish({ output: "late", elapsed_ms: 1000 });
  await waitFor(() => expect(screen.queryByText("late")).not.toBeInTheDocument());
});

test("LLM usage badge requires both the selected provider and model", () => {
  mocks.config.llm = {
    provider: "bytedance",
    default_model: "chosen",
    bytedance: { models: [{ id: "chosen" }, { id: "other" }] },
    deepseek: { models: [{ id: "chosen" }] },
  };
  detail(providers.find((p) => p.id === "deepseek") as RegistryProvider);
  expect(screen.queryByText("当前使用")).not.toBeInTheDocument();
  cleanup();
  detail(bytedance);
  fireEvent.click(screen.getByRole("tab", { name: "大语言" }));
  expect(screen.getAllByText("当前使用")).toHaveLength(1);
  expect(screen.getByRole("button", { name: "配置 chosen" })).toHaveTextContent("当前使用");
  expect(screen.getByRole("button", { name: "配置 other" })).not.toHaveTextContent("当前使用");
});

test("ASR usage badge follows the selected model and provider tests are absent", () => {
  mocks.config.audio = { provider: "doubao-streaming", models: ["doubao-streaming"] };
  detail(bytedance);
  expect(screen.getAllByText("当前使用")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "测试" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "大语言" }));
  expect(screen.queryByRole("button", { name: "测试" })).not.toBeInTheDocument();
  cleanup();
  detail(providers.find((p) => p.id === "elevenlabs") as RegistryProvider);
  expect(screen.queryByText("当前使用")).not.toBeInTheDocument();
});

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
  expect(llmUrl).toHaveValue("https://ark.cn-beijing.volces.com/api/v3");
  fireEvent.change(llmUrl, { target: { value: "https://example.com/v1" } });
  fireEvent.blur(llmUrl);
  expect(mocks.save.mock.calls.at(-1)?.[0].llm.bytedance.url).toBe("https://example.com/v1");
});

test("opening the LLM model dialog fetches models and refresh retries errors with a toast", async () => {
  detail(bytedance);
  fireEvent.click(screen.getByRole("tab", { name: "大语言" }));
  fireEvent.click(screen.getByRole("button", { name: "添加模型" }));
  expect(mocks.listModels).toHaveBeenCalledWith("bytedance");
  expect(await screen.findByText("model-a")).toBeInTheDocument();
  mocks.listModels.mockRejectedValueOnce(new Error("refresh failed"));
  fireEvent.click(screen.getByRole("button", { name: "刷新模型列表" }));
  await waitFor(() => expect(mocks.listModels).toHaveBeenCalledTimes(2));
  expect(await screen.findByText(/refresh failed/)).toBeInTheDocument();
  expect(screen.getByText("model-a")).toBeInTheDocument();
});

test("custom model is saved only after configuration and duplicate IDs are rejected", async () => {
  mocks.config.llm = { provider: "bytedance", bytedance: { models: [{ id: "existing" }] } };
  detail(bytedance);
  fireEvent.click(screen.getByRole("tab", { name: "大语言" }));
  fireEvent.click(screen.getByRole("button", { name: "添加模型" }));
  await screen.findByText("model-a");
  const custom = screen.getByRole("button", { name: "添加自定义模型" });
  expect(
    custom.compareDocumentPosition(screen.getByRole("button", { name: "model-a" })) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  fireEvent.click(custom);
  expect(
    within(screen.getByRole("dialog")).queryByRole("button", { name: "移除" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
  fireEvent.change(screen.getByRole("textbox", { name: "显示名称" }), {
    target: { value: "Test model" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "Model ID" }), {
    target: { value: "existing" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(await screen.findByText("该模型 ID 已添加")).toBeInTheDocument();
  expect(mocks.save).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("textbox", { name: "Model ID" }), {
    target: { value: "new-model" },
  });
  fireEvent.change(screen.getByRole("spinbutton", { name: "温度" }), { target: { value: "0.5" } });
  expect(mocks.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
  expect(mocks.save.mock.calls[0][0].llm.bytedance.models).toEqual([
    { id: "existing" },
    { id: "new-model", name: "Test model", params: { temperature: 0.5 } },
  ]);
});

test("closing a new custom model discards its draft", async () => {
  detail(bytedance);
  fireEvent.click(screen.getByRole("tab", { name: "大语言" }));
  fireEvent.click(screen.getByRole("button", { name: "添加模型" }));
  fireEvent.click(screen.getByRole("button", { name: "添加自定义模型" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Model ID" }), {
    target: { value: "draft" },
  });
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(mocks.save).not.toHaveBeenCalled();
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
  fireEvent.click(screen.getByRole("button", { name: "配置 Silero VAD" }));
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

test("Qwen credentials expose only Key and URL with a default and endpoint help", async () => {
  const qwen = providers.find((p) => p.id === "qwen") as RegistryProvider;
  const endpoint = "wss://maas.qianwenaiapi.com/api-ws/v1/inference";
  mocks.config.audio = {
    provider: "doubao-streaming",
    credentials: { qwen: { api_key: "test-key", url: "" } },
  };
  detail(qwen);
  expect(screen.getByDisplayValue("test-key")).toHaveAttribute("type", "password");
  const url = screen.getByDisplayValue(endpoint);
  expect(screen.queryByText("接入平台")).not.toBeInTheDocument();
  fireEvent.focus(screen.getByRole("button", { name: "URL说明" }));
  expect(screen.getByRole("tooltip")).toHaveTextContent(
    "{WorkspaceId}.cn-beijing.maas.aliyuncs.com",
  );
  expect(screen.getByRole("tooltip")).toHaveTextContent(
    "{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com",
  );
  fireEvent.change(url, { target: { value: "wss://custom.example/asr" } });
  fireEvent.blur(url);
  await waitFor(() => expect(mocks.save).toHaveBeenCalled());
  expect(mocks.save.mock.calls.at(-1)?.[0].audio.credentials.qwen).toEqual({
    api_key: "test-key",
    url: "wss://custom.example/asr",
  });
  expect(mocks.save.mock.calls.at(-1)?.[0].audio.provider).toBe("doubao-streaming");
  cleanup();
  mocks.config.audio = { credentials: { qwen: { api_key: "test-key", url: "   " } } };
  detail(qwen);
  expect(screen.getByDisplayValue(endpoint)).toBeInTheDocument();
});

test("Qwen model reset preserves provider credentials and active model", async () => {
  const qwen = providers.find((p) => p.id === "qwen") as RegistryProvider;
  const credentials = { qwen: { api_key: "test-key", url: "wss://custom.example/asr" } };
  mocks.config.audio = {
    provider: "doubao-streaming",
    models: ["qwen-asr-message", "qwen-asr-streaming"],
    credentials,
    "qwen-asr-message": { intermediate_result_enabled: false, enable_ddc: false },
  };
  detail(qwen);
  fireEvent.click(screen.getByRole("button", { name: "配置 Qwen ASR 3.1 Message" }));
  const dialog = within(screen.getByRole("dialog"));
  expect(dialog.getByText("实时中间结果")).toBeInTheDocument();
  expect(dialog.getByText("语义顺滑")).toBeInTheDocument();
  expect(dialog.queryByText("识别语言提示")).not.toBeInTheDocument();
  const reset = dialog.getByRole("button", { name: "恢复默认" });
  fireEvent.click(reset);
  await waitFor(() => expect(mocks.save).toHaveBeenCalled());
  const saved = mocks.save.mock.calls.at(-1)?.[0];
  expect(saved.audio.credentials).toEqual(credentials);
  expect(saved.audio.provider).toBe("doubao-streaming");
  expect(saved.audio["qwen-asr-message"]).toBeUndefined();
});

test("editing Qwen settings keeps legacy smoothing off and stores the shared field", async () => {
  const qwen = providers.find((p) => p.id === "qwen") as RegistryProvider;
  mocks.config.audio = {
    provider: "doubao-streaming",
    models: ["qwen-asr-message"],
    "qwen-asr-message": { disfluency_removal_enabled: false },
  };
  detail(qwen);
  fireEvent.click(screen.getByRole("button", { name: "配置 Qwen ASR 3.1 Message" }));
  const dialog = within(screen.getByRole("dialog"));
  expect(dialog.getByText("语义顺滑")).toBeInTheDocument();
  expect(dialog.queryByText("内置整理")).not.toBeInTheDocument();
  const toggles = dialog.getAllByRole("checkbox");
  expect(toggles[1]).not.toBeChecked();
  fireEvent.click(toggles[2]);
  await waitFor(() => expect(mocks.save).toHaveBeenCalled());
  const saved = mocks.save.mock.calls.at(-1)?.[0].audio["qwen-asr-message"];
  expect(saved).toMatchObject({ enable_ddc: false, keep_dialect: true });
  expect(saved).not.toHaveProperty("disfluency_removal_enabled");
});

test("Qwen LLM credentials show endpoint help and save independently of ASR", async () => {
  const qwen = providers.find((p) => p.id === "qwen") as RegistryProvider;
  mocks.config.audio = {
    provider: "qwen-asr-message",
    credentials: { qwen: { api_key: "asr-key", url: "wss://asr.example/inference" } },
  };
  const audio = mocks.config.audio;
  mocks.config.llm = { provider: "deepseek", qwen: { api_key: "llm-key", models: [] } };
  detail(qwen);
  expect(screen.getByRole("region", { name: "千问" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "大语言" }));
  expect(screen.getByDisplayValue("llm-key")).toHaveAttribute("type", "password");
  const url = screen.getByDisplayValue("https://maas.qianwenaiapi.com/compatible-mode/v1");
  fireEvent.focus(screen.getByRole("button", { name: "URL说明" }));
  expect(screen.getByRole("tooltip")).toHaveTextContent("ap-southeast-1.maas.qwencloudapi.com");
  expect(screen.getByRole("tooltip")).toHaveTextContent(
    "{WorkspaceId}.cn-beijing.maas.aliyuncs.com",
  );
  expect(screen.queryByText("接入平台")).not.toBeInTheDocument();
  fireEvent.change(url, {
    target: { value: "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1" },
  });
  fireEvent.blur(url);
  await waitFor(() => expect(mocks.save).toHaveBeenCalled());
  const saved = mocks.save.mock.calls.at(-1)?.[0];
  expect(saved.audio).toEqual(audio);
  expect(saved.llm.provider).toBe("deepseek");
  expect(saved.llm.qwen).toEqual({
    api_key: "llm-key",
    models: [],
    url: "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
  });
});

test("Qwen LLM discovers and saves models through the existing add-model flow", async () => {
  const qwen = providers.find((p) => p.id === "qwen") as RegistryProvider;
  mocks.config.llm = { provider: "deepseek", qwen: { api_key: "llm-key", models: [] } };
  mocks.listModels.mockResolvedValue({ data: [{ id: "qwen3.8-flash", name: "Flash" }] });
  const audio = mocks.config.audio;
  detail(qwen);
  fireEvent.click(screen.getByRole("tab", { name: "大语言" }));
  fireEvent.click(screen.getByRole("button", { name: "添加模型" }));
  fireEvent.click(await screen.findByRole("button", { name: "Flash" }));
  expect(mocks.listModels).toHaveBeenCalledWith("qwen");
  await waitFor(() => expect(mocks.save).toHaveBeenCalled());
  const saved = mocks.save.mock.calls.at(-1)?.[0];
  expect(saved.llm.qwen.models).toEqual([{ id: "qwen3.8-flash", name: "Flash" }]);
  expect(saved.llm.qwen.api_key).toBe("llm-key");
  expect(saved.audio).toEqual(audio);
});

test("Qwen LLM tests a saved model without switching the active provider", async () => {
  const qwen = providers.find((p) => p.id === "qwen") as RegistryProvider;
  mocks.config.llm = {
    provider: "deepseek",
    qwen: { api_key: "llm-key", models: [{ id: "qwen3.8-flash", name: "Flash" }] },
  };
  detail(qwen);
  fireEvent.click(screen.getByRole("tab", { name: "大语言" }));
  fireEvent.click(screen.getByRole("button", { name: "配置 Flash" }));
  fireEvent.click(screen.getByRole("button", { name: "测试" }));
  await waitFor(() =>
    expect(mocks.testModel).toHaveBeenCalledWith(
      expect.objectContaining({
        llm: expect.objectContaining({
          provider: "deepseek",
          qwen: expect.objectContaining({ api_key: "llm-key" }),
        }),
      }),
      "qwen",
      "qwen3.8-flash",
      "llm",
      expect.any(String),
    ),
  );
  expect(mocks.save).not.toHaveBeenCalled();
});

test("shared API keys are saved under api_key rather than url", async () => {
  const provider: RegistryProvider = {
    ...bytedance,
    credentials: { shared: { fields: [{ key: "api_key", type: "password" }] } },
  };
  const view = detail(provider);
  const input = view.container.querySelector('input[type="password"]') as HTMLInputElement;
  fireEvent.change(input, { target: { value: "shared-test-key" } });
  fireEvent.blur(input);
  await waitFor(() => expect(mocks.save).toHaveBeenCalled());
  expect(mocks.save.mock.calls[0][0].model_providers.credentials.bytedance).toEqual({
    api_key: "shared-test-key",
  });
});

test("model information shows capabilities above languages without opening configuration", () => {
  const qwen = providers.find((p) => p.id === "qwen") as RegistryProvider;
  mocks.config.audio = { provider: "qwen-asr-message" };
  detail(qwen);
  fireEvent.focus(screen.getAllByRole("button", { name: "模型信息" })[0]);
  const tooltip = screen.getByRole("tooltip");
  expect(tooltip).toHaveTextContent("流式输出");
  expect(tooltip).toHaveTextContent("支持语言");
  expect(tooltip.textContent?.indexOf("流式输出")).toBeLessThan(
    tooltip.textContent?.indexOf("支持语言") ?? 0,
  );
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
