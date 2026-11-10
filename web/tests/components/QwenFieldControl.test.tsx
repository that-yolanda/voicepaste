import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderControl } from "@/settings/components/models/FieldControl";
import { getFieldMeta } from "@/settings/lib/model";

describe("Qwen parameter controls", () => {
  it("allows setting and clearing the optional noise threshold", () => {
    const save = vi.fn();
    const meta = getFieldMeta("speech_noise_threshold", null, "qwen-asr-message");
    const { rerender } = render(renderControl(meta, null, save));
    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "0.2" } });
    fireEvent.blur(input);
    expect(save).toHaveBeenLastCalledWith(0.2);
    rerender(renderControl(meta, 0.2, save));
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(save).toHaveBeenLastCalledWith(null);
  });

  it("persists turning intermediate results off", () => {
    const save = vi.fn();
    render(
      renderControl(
        getFieldMeta("intermediate_result_enabled", true, "qwen-asr-message"),
        true,
        save,
      ),
    );
    fireEvent.click(screen.getByRole("checkbox"));
    expect(save).toHaveBeenCalledWith(false);
  });
});
