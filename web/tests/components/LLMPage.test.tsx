import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  save: vi.fn(),
  savePrompts: vi.fn(),
}));
vi.mock("@/settings/SettingsProvider", () => ({
  useSettings: () => ({ settings: { parsedConfig: mocks.config }, scheduleSave: mocks.save }),
}));
vi.mock("@/settings/bridge", () => ({
  loadPrompts: async () => [],
  loadBuiltinPrompts: async () => [{ id: "builtin", title: "测试润色", prompt: "修正错别字" }],
  savePrompts: mocks.savePrompts,
}));

import { LLMPage } from "@/settings/pages/LLMPage";

beforeEach(() => {
  mocks.config = {
    llm: {
      provider: "deepseek",
      deepseek: { api_key: "deepseek-test" },
      openai: { api_key: "openai-test", model: "saved-model" },
    },
  };
  mocks.save.mockReset().mockImplementation(async (patch) => {
    mocks.config = patch;
  });
  mocks.savePrompts.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("language model setup", () => {
  it("switches providers with Select and preserves each provider's saved settings", async () => {
    const view = render(<LLMPage />);
    const select = screen.getByRole("combobox", { name: "服务商" });
    expect(select).toHaveValue("deepseek");
    expect(screen.getByLabelText("API Key")).toHaveValue("deepseek-test");
    fireEvent.change(select, { target: { value: "openai" } });
    await waitFor(() => expect(mocks.save).toHaveBeenCalled());
    view.rerender(<LLMPage />);
    expect(select).toHaveValue("openai");
    expect(screen.getByLabelText("API Key")).toHaveValue("openai-test");
    expect(screen.getByDisplayValue("saved-model")).toBeInTheDocument();
    expect(
      screen.getByDisplayValue("https://api.openai.com/v1/chat/completions"),
    ).toBeInTheDocument();
    fireEvent.change(select, { target: { value: "deepseek" } });
    view.rerender(<LLMPage />);
    expect(screen.getByLabelText("API Key")).toHaveValue("deepseek-test");
  });

  it("adds a library template and lets users create and edit their own", async () => {
    render(<LLMPage />);
    fireEvent.click(screen.getByRole("button", { name: "模板库" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("测试润色");
    fireEvent.click(within(dialog).getByRole("button", { name: "添加" }));
    await screen.findByDisplayValue("测试润色");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    await waitFor(() => expect(screen.getAllByRole("textbox")).toHaveLength(6));
    const custom = screen.getByDisplayValue("新建润色模板");
    fireEvent.change(custom, { target: { value: "我的翻译" } });
    fireEvent.blur(custom);
    await waitFor(() =>
      expect(mocks.savePrompts).toHaveBeenLastCalledWith(
        expect.arrayContaining([expect.objectContaining({ title: "我的翻译" })]),
      ),
    );
  });
});
