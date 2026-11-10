import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { renderControl } from "@/settings/components/models/FieldControl";
import { getFieldMeta } from "@/settings/lib/model";

afterEach(cleanup);

test("language hints reject unsupported codes and more than four languages before saving", () => {
  const save = vi.fn();
  render(renderControl(getFieldMeta("language_hints", [], "qwen-asr-streaming"), [], save));
  const input = screen.getByRole("textbox");
  for (const invalid of ["zh, unknown", "zh, en, ja, ko, pl"]) {
    fireEvent.change(input, { target: { value: invalid } });
    fireEvent.blur(input);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
  }
  fireEvent.change(input, { target: { value: "ZH，en, zh, pl" } });
  fireEvent.blur(input);
  expect(save).toHaveBeenCalledWith(["zh", "en", "pl"]);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
