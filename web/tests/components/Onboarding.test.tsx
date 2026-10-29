import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Config } from "driver.js";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: { app: {} as { onboarding_pending?: boolean } },
  platform: "windows",
  save: vi.fn(),
  drivers: [] as { config: Config; destroy: () => void; drive: ReturnType<typeof vi.fn> }[],
}));
vi.mock("@/settings/SettingsProvider", () => ({
  useSettings: () => ({
    config: mocks.config,
    settings: { runtime: { platform: mocks.platform } },
    loading: false,
    scheduleSave: mocks.save,
  }),
}));
vi.mock("driver.js", () => ({
  driver: (config: Config) => {
    const instance = {
      config,
      drive: vi.fn((index: number) => {
        const step = config.steps?.[index];
        const popover = document.createElement("div");
        popover.className = "mock-popover";
        const title = document.createElement("h2");
        title.textContent = step?.popover?.title ?? "";
        const footerButtons = document.createElement("div");
        const previousButton = document.createElement("button");
        previousButton.textContent = config.prevBtnText ?? "";
        previousButton.onclick = () => config.onPrevClick?.(undefined, {} as never, {} as never);
        const nextButton = document.createElement("button");
        nextButton.onclick = () => {
          const callback =
            index === (config.steps?.length ?? 0) - 1 ? config.onDoneClick : config.onNextClick;
          callback?.(undefined, {} as never, {} as never);
        };
        footerButtons.append(previousButton, nextButton);
        const closeButton = document.createElement("button");
        closeButton.textContent = config.closeBtnLabel ?? "";
        closeButton.onclick = () => instance.destroy();
        popover.append(closeButton, title, footerButtons);
        document.body.append(popover);
        config.onPopoverRender?.(
          { title, footerButtons, previousButton, nextButton } as never,
          {} as never,
        );
        closeButton.focus();
        config.onHighlighted?.(undefined, {} as never, {} as never);
      }),
      destroy: () => {
        document.querySelector(".mock-popover")?.remove();
        config.onDestroyed?.(undefined, {} as never, {} as never);
      },
    };
    mocks.drivers.push(instance);
    return instance;
  },
}));

import i18next from "i18next";
import en from "@/locales/en.json";
import type { SectionId } from "@/settings/layout/Sidebar";
import { getSteps, waitForTarget } from "@/settings/onboarding/steps";
import { useOnboarding } from "@/settings/onboarding/useOnboarding";

function Harness() {
  const [mode, setMode] = useState("online");
  const [voiceMode, setVoiceMode] = useState("toggle");
  const [section, navigate] = useState<SectionId>("home");
  const onboarding = useOnboarding(navigate);
  return (
    <>
      <button type="button" onClick={() => void onboarding.start()}>
        手动引导
      </button>
      <span>{section}</span>
      <div data-tour="microphone" />
      <div data-tour="accessibility" />
      <div data-tour="llm-provider" />
      <div data-tour="llm-api-key" />
      <div data-tour="llm-library">
        <button type="button">模板库</button>
      </div>
      <div data-tour="llm-add-template" />
      <div data-tour="hotkey-main" />
      <div data-tour="hotkey-wake-edit">
        <button type="button">唤醒键</button>
      </div>
      <div data-tour="hotkey-voice-mode" data-voice-mode={voiceMode}>
        <button type="button" onClick={() => setVoiceMode("toggle")}>
          免提
        </button>
        <button type="button" onClick={() => setVoiceMode("hold")}>
          按住说话
        </button>
      </div>
      {voiceMode === "toggle" && (
        <div data-tour="hotkey-voice-start">
          <button type="button" disabled>
            开始录音键
          </button>
        </div>
      )}
      <div data-tour="hotkey-voice-key">
        <button type="button">结束录音键</button>
      </div>
      <div data-tour="hotkey-templates" />
      <div data-tour="asr-mode">
        <button type="button" onClick={() => setMode("online")}>
          在线模型
        </button>
        <button type="button" onClick={() => setMode("offline")}>
          本地模型
        </button>
      </div>
      <div data-tour="asr-models" data-model-kind={mode}>
        <input aria-label="API Key" />
      </div>
      {onboarding.guide}
      {onboarding.overlay}
    </>
  );
}

beforeEach(() => {
  mocks.config.app = {};
  mocks.platform = "windows";
  mocks.save.mockReset().mockResolvedValue(undefined);
  mocks.drivers.length = 0;
});
afterEach(cleanup);
const begin = async () => {
  fireEvent.click(screen.getByText("手动引导"));
  await screen.findByRole("button", { name: "退出" });
};
const lastDriver = () => mocks.drivers[mocks.drivers.length - 1];

describe("setup onboarding", () => {
  it.each([undefined, false])("does not invite legacy/dismissed users (%s)", (pending) => {
    mocks.config.app.onboarding_pending = pending;
    render(<Harness />);
    expect(screen.queryByText("配置 VoicePaste")).not.toBeInTheDocument();
  });

  it("invites new users and persists an explicit dismissal", async () => {
    mocks.config.app.onboarding_pending = true;
    render(<Harness />);
    fireEvent.click(screen.getByText("不再显示"));
    await waitFor(() => expect(screen.queryByText("配置 VoicePaste")).not.toBeInTheDocument());
    expect(mocks.save).toHaveBeenCalledWith({ app: { onboarding_pending: false } });
    expect(screen.queryByRole("button", { name: "退出" })).not.toBeInTheDocument();
  });

  it("keeps the invitation on screen when saving fails", async () => {
    mocks.config.app.onboarding_pending = true;
    mocks.save.mockRejectedValue(new Error("disk error"));
    render(<Harness />);
    fireEvent.click(screen.getByText("进入引导"));
    await screen.findByText("未能保存引导状态，请重试。");
    expect(screen.getByText("配置 VoicePaste")).toBeInTheDocument();
  });

  it("starts manually, reuses one checklist, exits, and can reopen", async () => {
    render(<Harness />);
    await begin();
    fireEvent.click(screen.getByText("手动引导"));
    expect(document.querySelectorAll(".voicepaste-checklist")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "退出" }));
    await waitFor(() => expect(document.querySelector(".voicepaste-checklist")).toBeNull());
    expect(mocks.save).toHaveBeenLastCalledWith({ app: { onboarding_pending: false } });
    await begin();
  });

  it("does not complete a task when the tour is closed early", async () => {
    render(<Harness />);
    await begin();
    fireEvent.click(screen.getByRole("button", { name: "系统权限" }));
    await waitFor(() => expect(mocks.drivers).toHaveLength(1));
    act(() => lastDriver().destroy());
    expect(document.querySelectorAll(".driver-checklist-item-done")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "系统权限" }));
    await waitFor(() => expect(mocks.drivers).toHaveLength(2));
    act(() => lastDriver().config.onDoneClick?.(undefined, {} as never, {} as never));
    expect(document.querySelectorAll(".driver-checklist-item-done")).toHaveLength(1);
  });

  it.each([0, 1, 2, 3])("lets users skip the optional LLM at step %s", async (index) => {
    render(<Harness />);
    await begin();
    fireEvent.click(screen.getByRole("button", { name: "大语言模型（可选）" }));
    await screen.findByRole("heading", { name: "选择服务商" });
    const targets = ["llm-provider", "llm-api-key", "llm-library", "llm-add-template"];
    for (let step = 0; step < index; step++) {
      fireEvent.click(await screen.findByRole("button", { name: "下一步" }));
      await waitFor(() => expect(lastDriver().drive).toHaveBeenCalledWith(step + 1));
    }
    expect(screen.getByText(index >= 2 ? "templates" : "llm", { exact: true })).toBeInTheDocument();
    expect(lastDriver().config.steps?.[index].element).toBe(
      document.querySelector(`[data-tour="${targets[index]}"]`),
    );
    expect(document.body).toHaveClass("voicepaste-tour-interactive");
    expect(lastDriver().config.allowKeyboardControl).toBe(false);
    fireEvent.click(await screen.findByRole("button", { name: "跳过此项" }));
    expect(document.body).not.toHaveClass("voicepaste-tour-interactive");
    expect(screen.getByRole("button", { name: "大语言模型（可选） (已跳过)" })).toBeInTheDocument();
    expect(document.querySelectorAll(".driver-checklist-item-done")).toHaveLength(1);
  });

  it("keeps the active task and progress when the language changes", async () => {
    i18next.addResourceBundle("en", "translation", en);
    render(<Harness />);
    await begin();
    fireEvent.click(screen.getByRole("button", { name: "系统权限" }));
    await waitFor(() => expect(mocks.drivers).toHaveLength(1));
    act(() => lastDriver().config.onDoneClick?.(undefined, {} as never, {} as never));
    fireEvent.click(screen.getByRole("button", { name: "大语言模型（可选）" }));
    await screen.findByRole("heading", { name: "选择服务商" });
    try {
      await act(async () => {
        await i18next.changeLanguage("en");
      });
      await screen.findByRole("heading", { name: "Choose a provider" });
      for (let index = 0; index < 3; index++) {
        fireEvent.click(await screen.findByRole("button", { name: "Next" }));
      }
      fireEvent.click(await screen.findByRole("button", { name: "Done" }));
      expect(
        screen.getByRole("button", { name: /System permissions\s*\(Guide completed\)/ }),
      ).toBeInTheDocument();
    } finally {
      await act(async () => {
        await i18next.changeLanguage("zh-CN");
      });
    }
  });

  it("Escape returns from shortcuts without interfering with shortcut recording", async () => {
    render(<Harness />);
    await begin();
    fireEvent.click(screen.getByRole("button", { name: "快捷键" }));
    await waitFor(() => expect(mocks.drivers).toHaveLength(1));
    expect(lastDriver().config.allowKeyboardControl).toBe(false);
    const recorder = document.createElement("div");
    recorder.dataset.hotkeyRecording = "true";
    document.body.appendChild(recorder);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("button", { name: "退出" })).not.toBeInTheDocument();
    recorder.remove();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("button", { name: "退出" })).toBeInTheDocument();
  });

  it("provides Accessibility only on macOS", () => {
    expect(getSteps("permissions", false, i18next.t)).toHaveLength(1);
    expect(getSteps("permissions", true, i18next.t)).toHaveLength(2);
  });

  it("pauses for an existing settings dialog and resumes the same task", async () => {
    render(<Harness />);
    await begin();
    fireEvent.click(screen.getByRole("button", { name: "大语言模型（可选）" }));
    await screen.findByRole("heading", { name: "选择服务商" });
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    await screen.findByRole("heading", { name: "填写 API Key" });
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    await screen.findByRole("heading", { name: "从模板库添加" });
    expect(screen.getByRole("button", { name: "模板库" })).toHaveFocus();
    const dialog = document.createElement("div");
    dialog.setAttribute("data-settings-dialog", "");
    await act(async () => document.body.appendChild(dialog));
    expect(screen.queryByRole("heading", { name: "从模板库添加" })).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    await act(async () => dialog.remove());
    await screen.findByRole("heading", { name: "从模板库添加" });
    expect(screen.getByRole("button", { name: "模板库" })).toHaveFocus();
    expect(lastDriver().drive).toHaveBeenCalledWith(2);
    expect(document.querySelectorAll(".driver-checklist-item-done")).toHaveLength(0);
  });

  it.each([
    "toggle",
    "hold",
  ])("guides the selected %s voice mode and template shortcuts", async (mode) => {
    render(<Harness />);
    await begin();
    fireEvent.click(screen.getByRole("button", { name: "快捷键" }));
    await screen.findByRole("heading", { name: "了解语音唤醒键" });
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    await screen.findByRole("heading", { name: "修改语音唤醒键" });
    expect(screen.getByRole("button", { name: "唤醒键" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    await screen.findByRole("heading", { name: "选择语音输入模式" });
    if (mode === "hold") fireEvent.click(screen.getByRole("button", { name: "按住说话" }));
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    if (mode === "toggle") {
      await screen.findByRole("heading", { name: "免提：开始录音" });
      fireEvent.click(screen.getByRole("button", { name: "下一步" }));
      await screen.findByRole("heading", { name: "免提：结束录音" });
    } else {
      await screen.findByRole("heading", { name: "设置按住说话的快捷键" });
    }
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    await screen.findByRole("heading", { name: "为润色模板设置快捷键" });
    fireEvent.click(screen.getByRole("button", { name: "上一步" }));
    await screen.findByRole("heading", {
      name: mode === "toggle" ? "免提：结束录音" : "设置按住说话的快捷键",
    });
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    fireEvent.click(await screen.findByRole("button", { name: "完成此项" }));
    expect(document.querySelectorAll(".driver-checklist-item-done")).toHaveLength(1);
  });

  it("updates the active key instructions if the voice mode changes", async () => {
    render(<Harness />);
    await begin();
    fireEvent.click(screen.getByRole("button", { name: "快捷键" }));
    for (const title of ["了解语音唤醒键", "修改语音唤醒键", "选择语音输入模式"]) {
      await screen.findByRole("heading", { name: title });
      fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    }
    await screen.findByRole("heading", { name: "免提：开始录音" });
    fireEvent.click(screen.getByRole("button", { name: "按住说话" }));
    await screen.findByRole("heading", { name: "设置按住说话的快捷键" });
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    await screen.findByRole("heading", { name: "为润色模板设置快捷键" });
  });

  it("keeps the checklist title and removes its description when all tasks finish", async () => {
    render(<Harness />);
    await begin();
    for (const task of ["系统权限", "语音识别模型", "大语言模型（可选）", "快捷键"]) {
      fireEvent.click(screen.getByRole("button", { name: task }));
      await waitFor(() => expect(screen.queryByRole("button", { name: "退出" })).toBeNull());
      await waitFor(() => expect(document.querySelector(".mock-popover")).not.toBeNull());
      act(() => lastDriver().config.onDoneClick?.(undefined, {} as never, {} as never));
    }
    expect(document.querySelector(".driver-checklist-title")).toHaveTextContent("配置引导");
    expect(document.querySelector(".driver-checklist-description")).toBeEmptyDOMElement();
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    await waitFor(() => expect(document.querySelector(".voicepaste-checklist")).toBeNull());
  });

  it("keeps ASR configuration interactive and updates instructions when switching modes", async () => {
    render(<Harness />);
    await begin();
    fireEvent.click(screen.getByRole("button", { name: "语音识别模型" }));
    await waitFor(() => expect(mocks.drivers).toHaveLength(1));
    act(() => lastDriver().config.onNextClick?.(undefined, {} as never, {} as never));
    await screen.findByRole("heading", { name: "启用在线模型" });
    expect(mocks.drivers).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "收起说明" }));
    expect(screen.queryByRole("button", { name: "完成此项" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "本地模型" }));
    await screen.findByRole("heading", { name: "启用本地模型" });
    fireEvent.click(screen.getByRole("button", { name: "展开说明" }));
    expect(screen.getByRole("button", { name: "完成此项" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "在线模型" }));
    await screen.findByRole("heading", { name: "启用在线模型" });
    const input = screen.getByRole("textbox", { name: "API Key" });
    fireEvent.change(input, { target: { value: "test-key" } });
    fireEvent.keyUp(input, { key: "ArrowRight" });
    expect(input).toHaveValue("test-key");
    expect(screen.getByRole("heading", { name: "启用在线模型" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "上一步" }));
    await waitFor(() => expect(mocks.drivers).toHaveLength(2));
    expect(screen.queryByRole("heading", { name: "启用在线模型" })).not.toBeInTheDocument();
    act(() => lastDriver().config.onNextClick?.(undefined, {} as never, {} as never));
    fireEvent.click(await screen.findByRole("button", { name: "完成此项" }));
    expect(document.querySelectorAll(".driver-checklist-item-done")).toHaveLength(1);
  });

  it("returns from floating ASR guidance without completing the task", async () => {
    render(<Harness />);
    await begin();
    const openConfig = async () => {
      fireEvent.click(screen.getByRole("button", { name: "语音识别模型" }));
      await screen.findByRole("heading", { name: "选择语音识别方式" });
      fireEvent.click(screen.getByRole("button", { name: "下一步" }));
      await screen.findByRole("heading", { name: "启用在线模型" });
    };
    await openConfig();
    fireEvent.click(screen.getByRole("button", { name: "返回配置清单" }));
    expect(document.querySelectorAll(".driver-checklist-item-done")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "退出" })).toBeInTheDocument();
    await openConfig();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("heading", { name: "启用在线模型" })).not.toBeInTheDocument();
  });

  it("unmount cancels an outstanding target wait and removes the checklist", async () => {
    const view = render(<Harness />);
    await begin();
    fireEvent.click(screen.getByRole("button", { name: "语音识别模型" }));
    view.unmount();
    await act(async () => {});
    expect(document.querySelector(".voicepaste-checklist")).toBeNull();
    expect(mocks.drivers).toHaveLength(0);
  });

  it("waits for dynamically mounted targets and supports cancellation", async () => {
    const controller = new AbortController();
    const pending = waitForTarget('[data-tour="dynamic"]', controller.signal);
    const target = document.createElement("div");
    target.dataset.tour = "dynamic";
    document.body.appendChild(target);
    await expect(pending).resolves.toBe(target);
    target.remove();
    const aborted = waitForTarget("#absent", controller.signal);
    controller.abort();
    await expect(aborted).rejects.toThrow("cancelled");
  });
});
