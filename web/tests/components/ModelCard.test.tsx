import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelCard, renderControl } from "@/settings/components/ModelCard";
import {
  ELEVENLABS_MODEL_ID,
  getFieldMeta,
  getMergedAsrConfig,
  parseLanguageList,
} from "@/settings/lib/model";
import type { RegistryModel } from "@/settings/types/models";
import registry from "../../../registry.json";

const model = registry.models.find((item) => item.id === ELEVENLABS_MODEL_ID) as RegistryModel;
const doubao = registry.models.find((item) => item.id === "doubao-streaming") as RegistryModel;
function card(selected = model, userConfig: Record<string, unknown> = {}) {
  const onConfigChange = vi.fn();
  render(
    <ModelCard
      model={selected}
      isActive={false}
      isDownloaded={false}
      userConfig={userConfig}
      onToggleActive={vi.fn()}
      onDownload={vi.fn()}
      onDelete={vi.fn()}
      onResetConfig={vi.fn()}
      onConfigChange={onConfigChange}
    />,
  );
  fireEvent.click(screen.getByText("参数配置"));
  return onConfigChange;
}
afterEach(cleanup);

describe("ElevenLabs model settings", () => {
  it("shows a backend validation failure instead of silently losing the edit", async () => {
    const change = card();
    change.mockRejectedValueOnce("ElevenLabs 语言代码格式无效");
    fireEvent.click(screen.getByText("更多参数"));
    const input = screen.getByPlaceholderText("留空则自动检测");
    fireEvent.change(input, { target: { value: "invalid" } });
    fireEvent.blur(input);
    expect(await screen.findByRole("alert")).toHaveTextContent("ElevenLabs 语言代码格式无效");
  });
  it("reuses shared metadata while keeping existing model groups", () => {
    expect(getFieldMeta("language", "").group).toBe("advanced");
    expect(getFieldMeta("language", "", model.id).group).toBe("advanced");
    expect(getFieldMeta("enable_ddc", false, model.id).label).toBe(
      getFieldMeta("enable_ddc", false).label,
    );
    card();
    expect(screen.queryByText("语言")).not.toBeInTheDocument();
    expect(screen.queryByText("过滤背景语音")).not.toBeInTheDocument();
    expect(screen.getByText("语义顺滑")).toBeVisible();
    expect(screen.getByText("文本确认方式")).toBeVisible();
    expect(screen.queryByRole("button", { name: "轮次预测" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "VAD分段" })).toBeVisible();
    expect(screen.getByText(/基础转写费用增加 20%/)).toBeVisible();
    expect(screen.getByText("API 申请指南")).toHaveAttribute(
      "href",
      "https://voicepaste.dev/docs/api/elevenlabs",
    );
    fireEvent.click(screen.getByText("更多参数"));
    expect(screen.getByText("语义顺滑")).toBeVisible();
    expect(screen.getByText(/基础转写费用增加 20%/)).toBeVisible();
    expect(screen.getByText("分段静音时长（秒）")).toBeVisible();
  });

  it("hides only VAD controls in manual mode", () => {
    card(model, { commit_strategy: "manual", vad_threshold: 0.6 });
    fireEvent.click(screen.getByText("更多参数"));
    expect(screen.queryByText("VAD 阈值")).not.toBeInTheDocument();
    expect(screen.queryByText("分段静音时长（秒）")).not.toBeInTheDocument();
    expect(screen.getByText("第二语言")).toBeVisible();
    expect(screen.getByRole("button", { name: "热词库说明" })).toBeVisible();
  });

  it("normalizes language lists on blur and preserves array storage", () => {
    expect(parseLanguageList(" ZH, en，zh, , EN")).toEqual(["zh", "en"]);
    const change = card();
    fireEvent.click(screen.getByText("更多参数"));
    const input = screen.getByPlaceholderText("例如 zh, en");
    fireEvent.change(input, { target: { value: " EN, zh, EN " } });
    expect(change).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(change).toHaveBeenCalledWith(model.id, { secondary_languages: ["en", "zh"] });
  });

  it("does not save out-of-range or fractional integer values", () => {
    const change = vi.fn();
    render(renderControl(getFieldMeta("min_speech_duration_ms", 100, model.id), 100, change));
    const input = screen.getByRole("spinbutton");
    for (const value of ["49", "2001", "100.5", ""]) {
      fireEvent.change(input, { target: { value } });
      fireEvent.blur(input);
      expect(change).not.toHaveBeenCalled();
    }
    fireEvent.change(input, { target: { value: "150" } });
    fireEvent.blur(input);
    expect(change).toHaveBeenCalledWith(150);
  });

  it("preserves Doubao credentials and advanced language layout", () => {
    card(doubao);
    expect(screen.getByPlaceholderText("输入 API Key")).toBeVisible();
    expect(screen.queryByText("语言")).not.toBeInTheDocument();
    expect(screen.getByText("API 申请指南")).toHaveAttribute(
      "href",
      "https://voicepaste.dev/docs/api/volcengine",
    );
    fireEvent.click(screen.getByText("更多参数"));
    expect(screen.getByText("语言")).toBeVisible();
    expect(screen.queryByRole("button", { name: "热词库说明" })).not.toBeInTheDocument();
  });
  it("orders basic and advanced fields exactly as requested", () => {
    const fields = getMergedAsrConfig(model, {});
    const names = (group: string) =>
      fields
        .filter((f) => getFieldMeta(f.key, f.value, model.id).group === group)
        .map((f) => f.key);
    expect([...names("credentials"), ...names("basic")]).toEqual([
      "api_key",
      "enable_ddc",
      "enable_keyterms",
      "commit_strategy",
    ]);
    expect(names("advanced")).toEqual([
      "language",
      "secondary_languages",
      "filter_background_audio",
      "transcript_edit",
      "vad_silence_threshold_secs",
      "vad_threshold",
      "min_speech_duration_ms",
      "min_silence_duration_ms",
    ]);
  });

  it("puts help in tooltips while keeping paid feature descriptions visible", () => {
    card();
    expect(screen.queryByText(/去除口头填充/)).not.toBeInTheDocument();
    fireEvent.focus(screen.getByRole("button", { name: "语义顺滑说明" }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("去除口头填充");
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.focus(screen.getByRole("button", { name: "文本确认方式说明" }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("不影响实时显示");
    expect(screen.getByRole("tooltip")).toHaveTextContent("都会等待最终结果再输出");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByText(/基础转写费用增加 20%/)).toBeVisible();
    fireEvent.click(screen.getByText("更多参数"));
    expect(screen.getByText(/基础转写费用增加 30%/)).toBeVisible();
    expect(screen.getByRole("button", { name: "转写编辑说明" })).toBeVisible();
  });

  it("saves multiline transcript editing instructions and limits input length", () => {
    const change = card();
    fireEvent.click(screen.getByText("更多参数"));
    const input = screen.getByPlaceholderText("例如：将日期统一写成 YYYY-MM-DD 格式");
    expect(input.tagName).toBe("TEXTAREA");
    expect(input).toHaveAttribute("maxlength", "2000");
    fireEvent.change(input, { target: { value: "Use digits.\nKeep names unchanged." } });
    fireEvent.blur(input);
    expect(change).toHaveBeenCalledWith(model.id, {
      transcript_edit: "Use digits.\nKeep names unchanged.",
    });
  });
});
