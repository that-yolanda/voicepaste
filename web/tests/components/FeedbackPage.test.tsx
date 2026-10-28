import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toast } from "@/settings/components/Toast";
import { useFeedback } from "@/settings/hooks/useFeedback";
import type { FeedbackPayload } from "@/settings/lib/feedback";
import { FeedbackPage } from "@/settings/pages/FeedbackPage";

const bridge = vi.hoisted(() => ({
  getFeedbackEnvironment: vi.fn(),
  getFeedbackLog: vi.fn(),
  getLogPath: vi.fn(),
  setFeedbackDraftActive: vi.fn(),
  submitFeedback: vi.fn(),
}));
vi.mock("@/settings/bridge", () => bridge);

function Harness({ active = true }: { active?: boolean }) {
  const feedback = useFeedback(active);
  return (
    <>
      {active ? <FeedbackPage feedback={feedback} /> : <span>其他设置</span>}
      <div role="status">
        <Toast toast={feedback.toast} />
      </div>
    </>
  );
}

beforeEach(() => {
  bridge.setFeedbackDraftActive.mockResolvedValue(undefined);
  bridge.getFeedbackEnvironment.mockResolvedValue({
    appVersion: "2.1.5",
    system: "macOS 15 (aarch64)",
  });
  bridge.getLogPath.mockResolvedValue("/test/app-data/voicepaste.log");
  bridge.getFeedbackLog.mockResolvedValue("[App][WARN] microphone unavailable");
  bridge.submitFeedback.mockResolvedValue({ ok: true });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

async function fillReport() {
  await waitFor(() => expect(screen.getByLabelText("系统版本")).toHaveValue("macOS 15 (aarch64)"));
  fireEvent.change(screen.getByLabelText(/标题/), { target: { value: "快捷键没有反应" } });
  fireEvent.change(screen.getByLabelText(/详细描述/), {
    target: { value: "按快捷键后没有开始录音。" },
  });
}

describe("App feedback", () => {
  it("validates required fields on blur before submission and clears corrected errors", async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByLabelText("App 版本")).toHaveValue("2.1.5"));
    const title = screen.getByLabelText(/标题/);
    const description = screen.getByLabelText(/详细描述/);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.blur(title);
    fireEvent.blur(description);
    expect(title).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("请输入标题。")).toBeInTheDocument();
    expect(screen.getByText("请填写问题描述或建议。")).toBeInTheDocument();
    expect(bridge.submitFeedback).not.toHaveBeenCalled();
    fireEvent.change(title, { target: { value: "   " } });
    expect(screen.getByText("请输入标题。")).toBeInTheDocument();
    fireEvent.change(title, { target: { value: "有效标题" } });
    fireEvent.change(description, { target: { value: "有效详情" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("blocks an empty report and focuses the first invalid field", async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByLabelText("App 版本")).toHaveValue("2.1.5"));
    fireEvent.click(screen.getByRole("button", { name: "提交反馈" }));
    expect(screen.getByLabelText(/标题/)).toHaveFocus();
    expect(screen.getAllByRole("alert")).toHaveLength(2);
    expect(bridge.submitFeedback).not.toHaveBeenCalled();
    expect(bridge.getFeedbackLog).not.toHaveBeenCalled();
  });

  it("submits the user-edited OS and App versions and resets defaults after success", async () => {
    render(<Harness />);
    await fillReport();
    fireEvent.change(screen.getByLabelText("系统版本"), { target: { value: "macOS 15.1" } });
    fireEvent.change(screen.getByLabelText("App 版本"), { target: { value: "2.1.4" } });
    fireEvent.click(screen.getByRole("button", { name: "提交反馈" }));
    await waitFor(() => expect(bridge.submitFeedback).toHaveBeenCalledOnce());
    expect(bridge.submitFeedback.mock.calls[0][0]).toMatchObject({
      system: "macOS 15.1",
      appVersion: "2.1.4",
    });
    await waitFor(() =>
      expect(screen.getByLabelText("系统版本")).toHaveValue("macOS 15 (aarch64)"),
    );
    expect(screen.getByLabelText("App 版本")).toHaveValue("2.1.5");
  });

  it("shows the actual log path in a tooltip without reading log contents", async () => {
    render(<Harness />);
    await fillReport();
    expect(screen.queryByText(/VoicePaste 2\.1\.5/)).not.toBeInTheDocument();
    expect(screen.queryByText(/单张最多/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("附件运行日志")).not.toBeChecked();
    fireEvent.focus(screen.getByRole("button", { name: "附件运行日志说明" }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("/test/app-data/voicepaste.log");
    expect(bridge.getFeedbackLog).not.toHaveBeenCalled();
  });
  it("keeps dirty feedback alive when closing the settings window until cleared", async () => {
    render(<Harness />);
    await fillReport();
    await waitFor(() => expect(bridge.setFeedbackDraftActive).toHaveBeenLastCalledWith(true));
    fireEvent.click(screen.getByRole("button", { name: "清空反馈" }));
    await waitFor(() => expect(bridge.setFeedbackDraftActive).toHaveBeenLastCalledWith(false));
    expect(screen.getByLabelText(/标题/)).toHaveValue("");
  });
  it("submits anonymously without reading logs by default", async () => {
    render(<Harness />);
    await fillReport();
    fireEvent.click(screen.getByRole("button", { name: "提交反馈" }));
    await waitFor(() => expect(bridge.submitFeedback).toHaveBeenCalledOnce());
    const payload: FeedbackPayload = bridge.submitFeedback.mock.calls[0][0];
    expect(payload.log).toBeNull();
    expect(payload.email).toBe("");
    expect(payload.system).toBe("macOS 15 (aarch64)");
    expect(bridge.getFeedbackLog).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByLabelText(/标题/)).toHaveValue(""));
  });

  it("preserves the exact ID and log when retrying, even across navigation", async () => {
    bridge.submitFeedback.mockRejectedValueOnce("send_failed");
    const view = render(<Harness />);
    await fillReport();
    fireEvent.click(screen.getByLabelText("附件运行日志"));
    fireEvent.click(screen.getByRole("button", { name: "提交反馈" }));
    await screen.findByText("暂时无法确认提交结果，内容已保留，请重试。");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    const first = bridge.submitFeedback.mock.calls[0][0];
    view.rerender(<Harness active={false} />);
    view.rerender(<Harness />);
    expect(screen.getByLabelText(/标题/)).toHaveValue("快捷键没有反应");
    fireEvent.click(screen.getByRole("button", { name: "提交反馈" }));
    await waitFor(() => expect(bridge.submitFeedback).toHaveBeenCalledTimes(2));
    expect(bridge.submitFeedback.mock.calls[1][0]).toEqual(first);
    expect(bridge.getFeedbackLog).toHaveBeenCalledOnce();
  });

  it("blocks repeat submissions and keeps loading state while navigating", async () => {
    let finish!: (value: unknown) => void;
    bridge.submitFeedback.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = render(<Harness />);
    await fillReport();
    fireEvent.click(screen.getByRole("button", { name: "提交反馈" }));
    await waitFor(() => expect(bridge.submitFeedback).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "正在提交…" })).toBeDisabled();
    view.rerender(<Harness active={false} />);
    view.rerender(<Harness />);
    expect(screen.getByRole("button", { name: "正在提交…" })).toBeDisabled();
    await act(async () => finish({ ok: true }));
    await screen.findByRole("button", { name: "提交反馈" });
    expect(bridge.submitFeedback).toHaveBeenCalledOnce();
  });

  it("retains content and lets users opt out when log collection fails", async () => {
    bridge.getFeedbackLog.mockRejectedValue("log_unavailable");
    render(<Harness />);
    await fillReport();
    fireEvent.click(screen.getByLabelText("附件运行日志"));
    fireEvent.click(screen.getByRole("button", { name: "提交反馈" }));
    await screen.findByText("无法读取运行日志，请取消附加日志后提交。");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(bridge.submitFeedback).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/标题/)).toHaveValue("快捷键没有反应");
    fireEvent.click(screen.getByLabelText("附件运行日志"));
    fireEvent.click(screen.getByRole("button", { name: "提交反馈" }));
    await waitFor(() => expect(bridge.submitFeedback).toHaveBeenCalledOnce());
  });

  it("resets incompatible categories when changing feedback type", async () => {
    render(<Harness />);
    await fillReport();
    fireEvent.change(screen.getByLabelText("涉及模块"), {
      target: { value: "microphone" },
    });
    fireEvent.click(screen.getByRole("button", { name: "需求建议" }));
    expect(screen.getByLabelText("涉及模块")).toHaveValue("");
  });
});
