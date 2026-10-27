import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockCheckForUpdates } = vi.hoisted(() => ({
  mockCheckForUpdates: vi.fn(),
}));

vi.mock("@/settings/bridge", () => ({
  checkForUpdates: mockCheckForUpdates,
  downloadUpdate: vi.fn(),
  installUpdate: vi.fn(),
  onUpdateProgress: vi.fn(() => () => {}),
}));

// UpdateButton keeps module-level singleton state (snapshot + hasChecked);
// reload the component tree per test so checks do not leak between cases.
beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function renderAboutUpdateArea() {
  const { ReleaseNotes } = await import("@/settings/components/ReleaseNotes");
  const { UpdateButton } = await import("@/settings/components/UpdateButton");
  render(
    <>
      <UpdateButton />
      <ReleaseNotes />
    </>,
  );
}

// Mirrors the manifest format produced by scripts/pack.ts: the `notes`
// string is a JSON-encoded {zh, en} payload.
const SAMPLE_NOTES = JSON.stringify({
  zh: [
    "本次更新新增语音识别。",
    "",
    "### 新功能与体验优化",
    "- **语音识别** — 支持实时转写。",
  ].join("\n"),
  en: [
    "This update adds speech recognition.",
    "",
    "### New Features",
    "- **Speech** — realtime.",
  ].join("\n"),
});

const LEGACY_PLAIN_NOTES = "### 旧版纯文本说明\n- 单语言 manifest 兼容显示。";

describe("ReleaseNotes", () => {
  it("renders parsed notes when an update is available", async () => {
    mockCheckForUpdates.mockResolvedValue({
      available: true,
      version: "2.1.6",
      notes: SAMPLE_NOTES,
    });

    await renderAboutUpdateArea();

    expect(await screen.findByText("v2.1.6 更新内容")).toBeInTheDocument();
    expect(screen.getByText("新功能与体验优化")).toBeInTheDocument();
    expect(screen.getByText("本次更新新增语音识别。")).toBeInTheDocument();
    expect(screen.getByText("语音识别")).toBeInTheDocument();
    // The English half of the bilingual payload must stay hidden for zh.
    expect(screen.queryByText("New Features")).not.toBeInTheDocument();
  });

  it("renders plain Markdown notes from legacy manifests", async () => {
    mockCheckForUpdates.mockResolvedValue({
      available: true,
      version: "2.1.6",
      notes: LEGACY_PLAIN_NOTES,
    });

    await renderAboutUpdateArea();

    expect(await screen.findByText("v2.1.6 更新内容")).toBeInTheDocument();
    expect(screen.getByText("旧版纯文本说明")).toBeInTheDocument();
    expect(screen.getByText("单语言 manifest 兼容显示。")).toBeInTheDocument();
  });

  it("renders nothing when the app is up to date", async () => {
    mockCheckForUpdates.mockResolvedValue({ available: false });

    await renderAboutUpdateArea();

    expect(await screen.findByText("已是最新版本")).toBeInTheDocument();
    expect(screen.queryByText(/更新内容/)).not.toBeInTheDocument();
  });

  it("renders nothing when the update carries no notes", async () => {
    mockCheckForUpdates.mockResolvedValue({
      available: true,
      version: "2.1.6",
      notes: "",
    });

    await renderAboutUpdateArea();

    expect(await screen.findByText("新版本 2.1.6 可用")).toBeInTheDocument();
    expect(screen.queryByText(/更新内容/)).not.toBeInTheDocument();
  });
});
