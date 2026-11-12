import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Config } from "driver.js";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: { app: {} as { onboarding_pending?: boolean } },
  platform: "windows",
  save: vi.fn(),
  openHelp: vi.fn().mockResolvedValue(undefined),
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
vi.mock("@/settings/bridge", () => ({ openHelpGuide: mocks.openHelp }));
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
        const description = document.createElement("p");
        description.textContent = step?.popover?.description ?? "";
        const footer = document.createElement("div");
        const footerButtons = document.createElement("div");
        footer.append(footerButtons);
        const previousButton = document.createElement("button");
        previousButton.textContent = config.prevBtnText ?? "";
        previousButton.onclick = () => config.onPrevClick?.(undefined, {} as never, {} as never);
        const nextButton = document.createElement("button");
        nextButton.onclick = () => {
          const callback =
            index === (config.steps?.length ?? 0) - 1 ? config.onDoneClick : config.onNextClick;
          callback?.(undefined, {} as never, {} as never);
        };
        previousButton.hidden = !config.showButtons?.includes("previous");
        nextButton.hidden = !config.showButtons?.includes("next");
        footerButtons.append(previousButton, nextButton);
        const closeButton = document.createElement("button");
        closeButton.textContent = config.closeBtnLabel ?? "";
        closeButton.onclick = () => instance.destroy();
        popover.append(closeButton, title, description, footer);
        document.body.append(popover);
        config.onPopoverRender?.(
          {
            title,
            wrapper: popover,
            footer,
            footerButtons,
            previousButton,
            nextButton,
          } as never,
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
  const [voiceMode, setVoiceMode] = useState("toggle");
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
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
      <div data-tour="models-defaults">
        <div data-tour="models-default-asr">
          <select aria-label="语音识别" defaultValue="">
            <option value="">—</option>
            <option value="speech">Speech</option>
          </select>
        </div>
        <div data-tour="models-default-llm">
          <select aria-label="大语言" defaultValue="">
            <option value="">—</option>
            <option value="text">Text</option>
          </select>
        </div>
      </div>
      <div data-tour="models-add-provider">
        <button
          type="button"
          aria-expanded={catalogOpen}
          onClick={() => setCatalogOpen((open) => !open)}
        >
          添加供应商
        </button>
      </div>
      <div data-tour="models-providers">
        {catalogOpen && <button type="button">添加 DeepSeek</button>}
        <input aria-label="API Key" />
        <button type="button" onClick={() => setDialogOpen(true)}>
          打开模型
        </button>
        {dialogOpen && (
          <div data-settings-dialog role="dialog">
            <button type="button" onClick={() => setDialogOpen(false)}>
              关闭模型
            </button>
          </div>
        )}
      </div>
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
  mocks.openHelp.mockClear();
});
afterEach(cleanup);
const begin = async () => {
  fireEvent.click(screen.getByText("手动引导"));
  await screen.findByRole("button", { name: "退出" });
};
const lastDriver = () => mocks.drivers[mocks.drivers.length - 1];

const next = async (title: string) => {
  fireEvent.click(await screen.findByRole("button", { name: "下一步" }));
  await screen.findByRole("heading", { name: title });
};

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

  it("uses four simple model steps and advances after clicking Add Provider", async () => {
    render(<Harness />);
    await begin();
    fireEvent.click(screen.getByRole("button", { name: "模型配置" }));
    await screen.findByRole("heading", { name: "选择需要的模型供应商" });
    expect(getSteps("models", false, i18next.t)).toHaveLength(4);
    expect(lastDriver().config.steps?.[0].element).toBe(
      document.querySelector('[data-tour="models-add-provider"]'),
    );
    expect(lastDriver().config.steps?.[0].popover?.side).toBe("bottom");
    expect(
      screen.getByText("选择需要的语音识别模型和大语言模型（可选，用于文本润色）。"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "添加供应商" }));
    await screen.findByRole("heading", { name: "配置模型服务" });
    expect(document.querySelector(".mock-popover")).toBeNull();
    expect(document.body).not.toHaveClass("voicepaste-tour-interactive");
    expect(document.querySelector(".onboarding-model-guide")).toHaveClass("top-4", "right-4");
    fireEvent.click(screen.getByRole("button", { name: "帮助" }));
    expect(mocks.openHelp).toHaveBeenCalledWith("compatibility");
    fireEvent.change(screen.getByRole("textbox", { name: "API Key" }), {
      target: { value: "test-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加 DeepSeek" }));
    expect(screen.getByRole("heading", { name: "配置模型服务" })).toBeInTheDocument();
    await next("选择语音识别模型");
    expect(lastDriver().config.steps?.[2].element).toBe(
      document.querySelector('[data-tour="models-default-asr"]'),
    );
    expect(screen.getByRole("combobox", { name: "语音识别" })).toHaveFocus();
    fireEvent.change(screen.getByRole("combobox", { name: "语音识别" }), {
      target: { value: "speech" },
    });
    await next("选择大语言模型（可选）");
    expect(lastDriver().config.steps?.[3].element).toBe(
      document.querySelector('[data-tour="models-default-llm"]'),
    );
    expect(screen.getByRole("combobox", { name: "大语言" })).toHaveFocus();
    expect(screen.queryByRole("button", { name: "帮助" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    expect(document.querySelectorAll(".driver-checklist-item-done")).toHaveLength(1);
  });

  it("allows skipping the optional language model without requiring configured models", async () => {
    render(<Harness />);
    await begin();
    fireEvent.click(screen.getByRole("button", { name: "模型配置" }));
    await screen.findByRole("heading", { name: "选择需要的模型供应商" });
    fireEvent.click(screen.getByRole("button", { name: "添加供应商" }));
    await screen.findByRole("heading", { name: "配置模型服务" });
    await next("选择语音识别模型");
    await next("选择大语言模型（可选）");
    fireEvent.click(screen.getByRole("button", { name: "跳过" }));
    expect(document.querySelectorAll(".driver-checklist-item-done")).toHaveLength(1);
  });

  it("keeps the active model step and checklist progress when the language changes", async () => {
    i18next.addResourceBundle("en", "translation", en);
    render(<Harness />);
    await begin();
    fireEvent.click(screen.getByRole("button", { name: "系统权限" }));
    fireEvent.click(await screen.findByRole("button", { name: "完成" }));
    fireEvent.click(screen.getByRole("button", { name: "模型配置" }));
    await screen.findByRole("heading", { name: "选择需要的模型供应商" });
    fireEvent.click(screen.getByRole("button", { name: "添加供应商" }));
    await screen.findByRole("heading", { name: "配置模型服务" });
    try {
      await act(async () => {
        await i18next.changeLanguage("en");
      });
      await screen.findByRole("heading", { name: "Configure model services" });
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      await screen.findByRole("heading", { name: "Choose a speech recognition model" });
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      await screen.findByRole("heading", { name: "Choose a language model (optional)" });
      fireEvent.click(screen.getByRole("button", { name: "Skip" }));
      expect(
        screen.getByRole("button", { name: /System permissions\s*\(Reviewed\)/ }),
      ).toBeInTheDocument();
    } finally {
      await act(async () => {
        await i18next.changeLanguage("zh-CN");
      });
    }
  });

  it("uses Help throughout the guide and Done on the final permission step", async () => {
    mocks.platform = "macos";
    render(<Harness />);
    await begin();
    fireEvent.click(screen.getByRole("button", { name: "系统权限" }));
    await screen.findByRole("heading", { name: "允许使用麦克风" });
    fireEvent.click(screen.getByRole("button", { name: "帮助" }));
    expect(mocks.openHelp).toHaveBeenCalledWith("permissions");
    await next("开启辅助功能权限");
    expect(screen.getByRole("button", { name: "完成" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "已浏览此项" })).toBeNull();
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

  it("pauses the model instructions for dialogs and resumes the same step", async () => {
    render(<Harness />);
    await begin();
    fireEvent.click(screen.getByRole("button", { name: "模型配置" }));
    await screen.findByRole("heading", { name: "选择需要的模型供应商" });
    fireEvent.click(screen.getByRole("button", { name: "添加供应商" }));
    await screen.findByRole("heading", { name: "配置模型服务" });
    fireEvent.click(screen.getByRole("button", { name: "打开模型" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "配置模型服务" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "关闭模型" }));
    await screen.findByRole("heading", { name: "配置模型服务" });
    expect(document.querySelector(".mock-popover")).toBeNull();
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
    fireEvent.click(await screen.findByRole("button", { name: "已浏览此项" }));
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
    for (const task of ["系统权限", "模型配置", "快捷键"]) {
      fireEvent.click(screen.getByRole("button", { name: task }));
      await waitFor(() => expect(screen.queryByRole("button", { name: "退出" })).toBeNull());
      if (task === "模型配置") {
        await screen.findByRole("heading", { name: "选择需要的模型供应商" });
        fireEvent.click(screen.getByRole("button", { name: "添加供应商" }));
        await screen.findByRole("heading", { name: "配置模型服务" });
        await next("选择语音识别模型");
        await next("选择大语言模型（可选）");
      }
      await waitFor(() => expect(document.querySelector(".mock-popover")).not.toBeNull());
      act(() => lastDriver().config.onDoneClick?.(undefined, {} as never, {} as never));
    }
    expect(document.querySelector(".driver-checklist-title")).toHaveTextContent("配置引导");
    expect(document.querySelector(".driver-checklist-description")).toBeEmptyDOMElement();
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    await waitFor(() => expect(document.querySelector(".voicepaste-checklist")).toBeNull());
  });

  it("returns from model selection to the floating configuration instructions", async () => {
    render(<Harness />);
    await begin();
    fireEvent.click(screen.getByRole("button", { name: "模型配置" }));
    await screen.findByRole("heading", { name: "选择需要的模型供应商" });
    fireEvent.click(screen.getByRole("button", { name: "添加供应商" }));
    await screen.findByRole("heading", { name: "配置模型服务" });
    await next("选择语音识别模型");
    fireEvent.click(screen.getByRole("button", { name: "上一步" }));
    await screen.findByRole("heading", { name: "配置模型服务" });
    expect(document.querySelector(".mock-popover")).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("button", { name: "退出" })).toBeInTheDocument();
  });

  it("returns from floating ASR guidance without completing the task", async () => {
    render(<Harness />);
    await begin();
    const openConfig = async () => {
      fireEvent.click(screen.getByRole("button", { name: "模型配置" }));
      await screen.findByRole("heading", { name: "选择需要的模型供应商" });
    };
    await openConfig();
    fireEvent.click(screen.getByRole("button", { name: "返回配置清单" }));
    expect(document.querySelectorAll(".driver-checklist-item-done")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "退出" })).toBeInTheDocument();
    await openConfig();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("heading", { name: "选择需要的模型供应商" })).not.toBeInTheDocument();
  });

  it("opens the current task's documentation from a tour popover", async () => {
    render(<Harness />);
    await begin();
    fireEvent.click(screen.getByRole("button", { name: "快捷键" }));
    fireEvent.click(await screen.findByRole("button", { name: "帮助" }));
    expect(mocks.openHelp).toHaveBeenCalledWith("hotkeys");
  });

  it("unmount cancels an outstanding target wait and removes the checklist", async () => {
    const view = render(<Harness />);
    await begin();
    fireEvent.click(screen.getByRole("button", { name: "模型配置" }));
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
