import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { HotwordsPage } from "@/settings/pages/HotwordsPage";
import { TemplatesPage } from "@/settings/pages/TemplatesPage";

const mocks = vi.hoisted(() => ({
  loadPrompts: vi.fn(),
  savePrompts: vi.fn(),
  loadBuiltinPrompts: vi.fn(),
  loadHotwords: vi.fn(),
  saveHotwords: vi.fn(),
  loadBuiltinHotwords: vi.fn(),
}));
vi.mock("@/settings/bridge", () => mocks);
beforeEach(() => {
  vi.resetAllMocks();
  mocks.loadPrompts.mockResolvedValue([
    { id: "a", title: "First", prompt: "Original", hotkey: "F13", hotkey_mode: "toggle" },
    { id: "b", title: "Second", prompt: "Other" },
  ]);
  mocks.savePrompts.mockResolvedValue(undefined);
  mocks.loadBuiltinPrompts.mockResolvedValue([
    { id: "builtin", title: "Preset", prompt: "Preset text" },
  ]);
  mocks.loadHotwords.mockResolvedValue({
    active_group: "a",
    groups: [
      { id: "a", name: "First", words: ["Tauri"] },
      { id: "b", name: "Second", words: ["VoicePaste"] },
    ],
  });
  mocks.saveHotwords.mockResolvedValue(undefined);
});
afterEach(cleanup);

test("templates start collapsed and editing an expanded template preserves its shortcut", async () => {
  render(<TemplatesPage />);
  const first = await screen.findByRole("button", { name: /^First/ });
  expect(first).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByDisplayValue("Original")).not.toBeInTheDocument();
  fireEvent.click(first);
  const content = screen.getByDisplayValue("Original");
  fireEvent.change(content, { target: { value: "Edited" } });
  fireEvent.blur(content);
  await waitFor(() =>
    expect(mocks.savePrompts).toHaveBeenCalledWith([
      expect.objectContaining({ id: "a", prompt: "Edited", hotkey: "F13", hotkey_mode: "toggle" }),
      expect.objectContaining({ id: "b", prompt: "Other" }),
    ]),
  );
  fireEvent.click(screen.getByRole("button", { name: "Second" }));
  expect(first).toHaveAttribute("aria-expanded", "false");
  expect(document.getElementById(first.getAttribute("aria-controls") ?? "")).toHaveAttribute(
    "inert",
  );
});

test("adding and cloning templates opens the new editor with independent saved content", async () => {
  render(<TemplatesPage />);
  await screen.findByRole("button", { name: "First" });
  fireEvent.click(screen.getByRole("button", { name: "添加" }));
  expect(screen.getByRole("button", { name: "新建润色模板" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  fireEvent.click(screen.getByRole("button", { name: "模板" }));
  const dialog = within(screen.getByRole("dialog"));
  fireEvent.click(await dialog.findByRole("button", { name: "添加" }));
  expect(screen.getByRole("button", { name: "Preset" })).toHaveAttribute("aria-expanded", "true");
  await waitFor(() =>
    expect(mocks.savePrompts).toHaveBeenLastCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Preset",
          prompt: "Preset text",
          id: expect.not.stringMatching(/^builtin$/),
        }),
      ]),
    ),
  );
});

test("expanded hotword lists keep single selection, word editing and deletion working", async () => {
  render(<HotwordsPage />);
  const first = await screen.findByRole("button", { name: /^First/ });
  expect(first).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(screen.getByRole("button", { name: "Second" }));
  fireEvent.click(screen.getByRole("button", { name: /^Second/ }));
  expect(mocks.saveHotwords).toHaveBeenLastCalledWith(
    expect.objectContaining({ active_group: "b" }),
  );
  expect(screen.getByRole("button", { name: /^Second/ })).toHaveTextContent("当前使用");
  expect(first).not.toHaveTextContent("当前使用");
  const input = screen.getByPlaceholderText(/逗号分隔/);
  fireEvent.change(input, { target: { value: "Rust, Tauri" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(mocks.saveHotwords).toHaveBeenLastCalledWith(
    expect.objectContaining({
      groups: expect.arrayContaining([
        expect.objectContaining({ id: "b", words: ["VoicePaste", "Rust", "Tauri"] }),
      ]),
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "移除" }));
  expect(mocks.saveHotwords).toHaveBeenLastCalledWith({
    active_group: "a",
    groups: [{ id: "a", name: "First", words: ["Tauri"] }],
  });
});
