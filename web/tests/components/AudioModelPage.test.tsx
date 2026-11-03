import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelCard } from "@/settings/components/ModelCard";
import { languageName } from "@/settings/lib/languages";
import { AudioModelPage } from "@/settings/pages/AudioModelPage";
import type { RegistryModel } from "@/settings/types/models";
import registry from "../../../registry.json";

const save = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const corpus = {
  boosting_table_id: "old-table",
  correct_table_id: "corrections",
  context: '{"context_type":"dialog_ctx","context_data":[{"text":"history"}]}',
};
vi.mock("@/settings/bridge", () => ({
  getModelRegistry: async () => registry.models,
  getDownloadedModels: async () => [],
  getAudioConfigDefaults: async () => ({ ...registry.defaults.asr, vad: registry.defaults.vad }),
  onModelDownloadProgress: () => () => {},
  saveConfigObject: save,
  downloadModel: vi.fn(),
  deleteModel: vi.fn(),
}));
vi.mock("@/settings/SettingsProvider", () => ({
  useSettings: () => ({
    settings: {
      parsedConfig: { audio: { provider: "doubao-streaming", "doubao-streaming": { corpus } } },
    },
    refresh: vi.fn(),
  }),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ASR language filtering", () => {
  it("uses a single select with Chinese and English first, preserving the filter across tabs", async () => {
    render(<AudioModelPage />);
    await screen.findByText("火山引擎 - 豆包流式语音识别模型2.0");
    const filter = screen.getByRole("combobox", { name: "按支持的语言筛选" });
    expect(
      within(filter)
        .getAllByRole("option")
        .slice(0, 3)
        .map((option) => option.textContent),
    ).toEqual(["语言：全部", "中文", "英语"]);
    expect(filter).not.toHaveAttribute("multiple");
    fireEvent.change(filter, { target: { value: "pl" } });
    fireEvent.click(screen.getByRole("button", { name: "本地模型" }));
    expect(screen.getByText("Qwen3 ASR 多语言")).toBeInTheDocument();
    expect(screen.queryByText("SenseVoice 多语言")).not.toBeInTheDocument();
    expect(screen.queryByText("Zipformer 流式中文")).not.toBeInTheDocument();
    expect(screen.getByText("Silero VAD")).toBeInTheDocument();
    expect(filter).toHaveValue("pl");
    expect(save).not.toHaveBeenCalled();
    fireEvent.change(filter, { target: { value: "ja" } });
    expect(screen.getByText("SenseVoice 多语言")).toBeInTheDocument();
    fireEvent.change(filter, { target: { value: "" } });
    expect(screen.getByText("Zipformer 流式中文")).toBeInTheDocument();
  });

  it("shows an empty state while keeping local dependencies available", async () => {
    render(<AudioModelPage />);
    await screen.findByText("火山引擎 - 豆包流式语音识别模型2.0");
    fireEvent.change(screen.getByRole("combobox", { name: "按支持的语言筛选" }), {
      target: { value: "uk" },
    });
    fireEvent.click(screen.getByRole("button", { name: "本地模型" }));
    expect(screen.getByText("没有支持所选语言的模型，请调整语言筛选。")).toBeInTheDocument();
    expect(screen.getByText("Silero VAD")).toBeInTheDocument();
  });

  it("preserves context and the correction table when editing the hotword table", async () => {
    render(<AudioModelPage />);
    await screen.findByText("火山引擎 - 豆包流式语音识别模型2.0");
    fireEvent.click(screen.getAllByRole("button", { name: "参数配置" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "更多参数" }));
    const table = screen.getByPlaceholderText("输入热词表 ID");
    fireEvent.change(table, { target: { value: "new-table" } });
    fireEvent.blur(table);
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        audio: expect.objectContaining({
          "doubao-streaming": { corpus: { ...corpus, boosting_table_id: "new-table" } },
        }),
      }),
    );
  });

  it("uses normalized codes and localized names across providers", () => {
    expect(languageName("yue", "en")).toBe("Cantonese");
    expect(languageName("pl", "zh-CN")).toBe("波兰语");
    for (const model of registry.models) {
      expect(new Set(model.languages).size).toBe(model.languages.length);
      for (const code of model.languages) expect(languageName(code, "zh-CN")).not.toBe(code);
    }
  });
});

function DoubaoCard({ initial = {} }: { initial?: Record<string, unknown> }) {
  const [config, setConfig] = useState(initial);
  const model = registry.models.find((item) => item.id === "doubao-streaming") as RegistryModel;
  return (
    <ModelCard
      model={model}
      isActive
      isDownloaded
      userConfig={config}
      onToggleActive={vi.fn()}
      onDownload={vi.fn()}
      onDelete={vi.fn()}
      onResetConfig={vi.fn()}
      onConfigChange={(_id, patch) => setConfig((current) => ({ ...current, ...patch }))}
    />
  );
}

describe("Doubao configuration", () => {
  it("switches modes and resources, displaying resource IDs in the options", () => {
    render(<DoubaoCard />);
    fireEvent.click(screen.getByRole("button", { name: "参数配置" }));
    expect(screen.getByRole("combobox", { name: "识别方式" })).toHaveValue(
      "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async",
    );
    expect(screen.queryByRole("combobox", { name: "识别语言" })).not.toBeInTheDocument();
    expect(screen.getByText("二遍校正")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "资源类型" }), {
      target: { value: "volc.seedasr.sauc.concurrent" },
    });
    expect(
      screen.getByRole("option", { name: "小时版 (volc.seedasr.sauc.duration)" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "并发版 (volc.seedasr.sauc.concurrent)" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("volc.seedasr.sauc.concurrent")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "识别方式" }), {
      target: { value: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream" },
    });
    const language = screen.getByRole("combobox", { name: "识别语言" });
    fireEvent.change(language, { target: { value: "pl-PL" } });
    expect(language).toHaveValue("pl-PL");
    expect(screen.queryByText("二遍校正")).not.toBeInTheDocument();
    expect(screen.queryByText(/热词用于引导识别/)).not.toBeInTheDocument();
    const languages = screen.getByRole("button", { name: /^支持语言：/ });
    fireEvent.focus(languages);
    expect(
      within(screen.getByRole("tooltip")).getByText(/其他语种需选择一句话识别/),
    ).toBeInTheDocument();
  });

  it("keeps saved legacy values visible until explicitly replaced", () => {
    render(
      <DoubaoCard
        initial={{ url: "wss://example.test/custom", resource_id: "volc.bigasr.sauc.duration" }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "参数配置" }));
    expect(screen.getByRole("combobox", { name: "识别方式" })).toHaveValue(
      "wss://example.test/custom",
    );
    expect(screen.getByRole("combobox", { name: "资源类型" })).toHaveValue(
      "volc.bigasr.sauc.duration",
    );
  });
});
