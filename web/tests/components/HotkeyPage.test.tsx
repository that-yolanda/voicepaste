import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settings: {
    parsedConfig: {
      app: { hotkey: "F13" as string | undefined, hotkey_mode: "toggle", voice_hotkey: "F2" },
    },
    runtime: {
      platform: "windows",
      hotkeyIssues: [] as { id: string; code: string; params?: Record<string, string> }[],
    },
  },
  save: vi.fn(),
  refresh: vi.fn(),
  loadPrompts: vi.fn(),
  savePrompts: vi.fn(),
  validate: vi.fn(),
  record: vi.fn(),
}));
vi.mock("@/settings/SettingsProvider", () => ({
  useSettings: () => ({
    settings: mocks.settings,
    scheduleSave: mocks.save,
    refresh: mocks.refresh,
  }),
}));
vi.mock("@/settings/bridge", () => ({
  loadPrompts: mocks.loadPrompts,
  savePrompts: mocks.savePrompts,
  validateHotkeySettings: mocks.validate,
  recordHotkey: mocks.record,
}));

import { HotkeyPage } from "@/settings/pages/HotkeyPage";

beforeEach(() => {
  mocks.settings.parsedConfig.app = {
    hotkey: "F13" as string | undefined,
    hotkey_mode: "toggle",
    voice_hotkey: "F2",
  };
  mocks.settings.runtime.platform = "windows";
  mocks.settings.runtime.hotkeyIssues = [];
  mocks.loadPrompts.mockResolvedValue([
    { id: "p", title: "润色", hotkey: "ShiftLeft", hotkey_mode: "toggle" },
  ]);
  mocks.validate.mockResolvedValue(undefined);
  mocks.save.mockResolvedValue(undefined);
  mocks.refresh.mockResolvedValue(undefined);
  mocks.savePrompts.mockResolvedValue({ ok: true });
  mocks.record.mockResolvedValue({ keys: ["F3"], displayString: "F3", hotkey: "F3" });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("HotkeyPage", () => {
  it.each([
    ["macos", "⌘"],
    ["windows", "Ctrl"],
  ])("shows the platform default when the global key is missing on %s", async (platform, label) => {
    mocks.settings.runtime.platform = platform;
    mocks.settings.parsedConfig.app.hotkey = undefined;
    render(<HotkeyPage />);
    await screen.findByText("润色");
    expect(screen.getAllByLabelText("快捷键")[0]).toHaveTextContent(label);
  });
  it("keeps an explicitly cleared global key unbound", async () => {
    mocks.settings.parsedConfig.app.hotkey = "";
    render(<HotkeyPage />);
    await screen.findByText("润色");
    expect(screen.getAllByLabelText("快捷键")[0]).not.toHaveTextContent("Ctrl");
  });
  it("lets raw toggle stop change independently from its locked global start", async () => {
    render(<HotkeyPage />);
    await screen.findByText("润色");
    const fields = screen.getAllByLabelText("快捷键");
    expect(fields[1]).toBeDisabled();
    expect(fields[2]).toHaveTextContent("F2");
    fireEvent.click(fields[2]);
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith({ app: { voice_hotkey: "F3" } }));
    expect(mocks.validate).toHaveBeenCalled();
  });
  it("rejects a conflicting edit with a toast and leaves the old key", async () => {
    mocks.validate.mockRejectedValue("快捷键存在包含关系");
    render(<HotkeyPage />);
    await screen.findByText("润色");
    fireEvent.click(screen.getAllByLabelText("快捷键")[0]);
    expect(await screen.findByText("快捷键存在包含关系")).toBeInTheDocument();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(screen.getAllByLabelText("快捷键")[0]).toHaveTextContent("F13");
  });
  it("keeps the global wake editable and requires first-key validation for raw hold", async () => {
    mocks.settings.parsedConfig.app.hotkey_mode = "hold";
    mocks.settings.parsedConfig.app.voice_hotkey = "";
    render(<HotkeyPage />);
    await screen.findByText("润色");
    const fields = screen.getAllByLabelText("快捷键");
    expect(fields[0]).toBeEnabled();
    fireEvent.click(fields[1]);
    await waitFor(() => expect(mocks.record).toHaveBeenCalledWith("main"));
  });
  it("shows legacy disabled-binding warnings only in a transient toast", async () => {
    mocks.settings.runtime.hotkeyIssues = [
      { id: "voice", code: "hotkey.needs_modifier", params: { title: "voice" } },
    ];
    render(<HotkeyPage />);
    const warning = screen.getByText("语音输入：快捷键需包含功能键、Tab 或修饰键");
    expect(warning.closest("section")).toBeNull();
    expect(warning.closest(".fixed")).not.toBeNull();
    await screen.findByText("润色");
  });
  it("does not optimistically apply rejected template changes", async () => {
    mocks.savePrompts.mockRejectedValue("润色键与全局主键重复");
    render(<HotkeyPage />);
    await screen.findByText("润色");
    const fields = screen.getAllByLabelText("快捷键");
    fireEvent.click(fields[fields.length - 1]);
    expect(await screen.findByText("润色键与全局主键重复")).toBeInTheDocument();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it("switches raw mode and clears a conflicting shortcut instead of rejecting the switch", async () => {
    mocks.validate.mockRejectedValueOnce("快捷键存在包含关系").mockResolvedValue(undefined);
    render(<HotkeyPage />);
    await screen.findByText("润色");
    fireEvent.click(screen.getAllByRole("button", { name: "按住说话" })[0]);
    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith({ app: { hotkey_mode: "hold", voice_hotkey: "" } }),
    );
    expect(await screen.findByText(/已清除该快捷键/)).toBeInTheDocument();
    expect(mocks.validate).toHaveBeenCalledTimes(2);
  });
  it("retains a valid shortcut when switching raw mode", async () => {
    render(<HotkeyPage />);
    await screen.findByText("润色");
    fireEvent.click(screen.getAllByRole("button", { name: "按住说话" })[0]);
    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith({ app: { hotkey_mode: "hold", voice_hotkey: "F2" } }),
    );
    expect(screen.queryByText(/已清除该快捷键/)).not.toBeInTheDocument();
  });
  it("switches template mode and clears its conflicting shortcut only", async () => {
    mocks.validate.mockRejectedValueOnce("润色键与全局主键包含").mockResolvedValue(undefined);
    render(<HotkeyPage />);
    await screen.findByText("润色");
    fireEvent.click(screen.getAllByRole("button", { name: "按住说话" })[1]);
    await waitFor(() =>
      expect(mocks.savePrompts).toHaveBeenCalledWith([
        expect.objectContaining({ id: "p", hotkey_mode: "hold", hotkey: "" }),
      ]),
    );
    expect(mocks.save).not.toHaveBeenCalled();
    expect(await screen.findByText(/已清除该快捷键/)).toBeInTheDocument();
  });
  it("never clears a shortcut for a persistence failure", async () => {
    mocks.save.mockRejectedValue("写入失败");
    render(<HotkeyPage />);
    await screen.findByText("润色");
    fireEvent.click(screen.getAllByRole("button", { name: "按住说话" })[0]);
    expect(await screen.findByText("写入失败")).toBeInTheDocument();
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.save).toHaveBeenCalledWith({ app: { hotkey_mode: "hold", voice_hotkey: "F2" } });
  });
  it("does not repeat a warning after an unchanged settings refresh", async () => {
    mocks.settings.runtime.hotkeyIssues = [
      {
        id: "p",
        code: "hotkey.conflict",
        params: { aTitle: "main", aKey: "Ctrl", bTitle: "p", bKey: "Ctrl" },
      },
    ];
    const view = render(<HotkeyPage />);
    await screen.findByText("润色");
    view.rerender(<HotkeyPage />);
    const message = "全局主键（Ctrl）与p（Ctrl）快捷键重复或包含，冲突绑定已停用";
    expect(screen.getAllByText(message)).toHaveLength(1);
    expect(screen.getByText(message).closest(".fixed")).not.toBeNull();
  });
});
