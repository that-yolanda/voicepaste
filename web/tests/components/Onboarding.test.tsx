import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
      drive: vi.fn(),
      destroy: () => config.onDestroyed?.(undefined, {} as never, {} as never),
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
      <div data-tour="llm-config" />
      <div data-tour="llm-templates" />
      <div data-tour="hotkey-main" />
      <div data-tour="hotkey-voice" />
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
  await screen.findByRole("button", { name: "退出引导" });
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
    expect(screen.queryByRole("button", { name: "退出引导" })).not.toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: "退出引导" }));
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

  it("lets users skip the optional LLM without claiming it was verified", async () => {
    render(<Harness />);
    await begin();
    fireEvent.click(screen.getByRole("button", { name: "大语言模型（可选）" }));
    await waitFor(() => expect(mocks.drivers).toHaveLength(1));
    const footerButtons = document.createElement("div");
    const previousButton = document.createElement("button");
    const nextButton = document.createElement("button");
    act(() =>
      lastDriver().config.onPopoverRender?.(
        { footerButtons, previousButton, nextButton } as never,
        {} as never,
      ),
    );
    fireEvent.click(within(footerButtons).getByRole("button", { name: "跳过此项" }));
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
    await waitFor(() => expect(mocks.drivers).toHaveLength(2));
    try {
      await act(async () => {
        await i18next.changeLanguage("en");
      });
      await waitFor(() => expect(mocks.drivers).toHaveLength(3));
      expect(lastDriver().config.doneBtnText).toBe("Finish this task");
      act(() => lastDriver().destroy());
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
    expect(screen.queryByRole("button", { name: "退出引导" })).not.toBeInTheDocument();
    recorder.remove();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("button", { name: "退出引导" })).toBeInTheDocument();
  });

  it("provides Accessibility only on macOS", () => {
    expect(getSteps("permissions", false, i18next.t)).toHaveLength(1);
    expect(getSteps("permissions", true, i18next.t)).toHaveLength(2);
  });

  it("pauses for an existing settings dialog and resumes the same task", async () => {
    render(<Harness />);
    await begin();
    fireEvent.click(screen.getByRole("button", { name: "大语言模型（可选）" }));
    await waitFor(() => expect(mocks.drivers).toHaveLength(1));
    const dialog = document.createElement("div");
    dialog.setAttribute("data-settings-dialog", "");
    await act(async () => document.body.appendChild(dialog));
    await act(async () => dialog.remove());
    await waitFor(() => expect(mocks.drivers).toHaveLength(2));
    expect(lastDriver().drive).toHaveBeenCalledWith(0);
    expect(document.querySelectorAll(".driver-checklist-item-done")).toHaveLength(0);
  });

  it("unmount cancels an outstanding target wait and removes the checklist", async () => {
    const view = render(<Harness />);
    await begin();
    fireEvent.click(screen.getByRole("button", { name: "语音模型" }));
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
