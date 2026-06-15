import { describe, expect, it } from "vitest";
import { mergeHotwords, parseHotwordInput } from "@/lib/hotwords";

describe("parseHotwordInput", () => {
  it("returns a single entry untouched (no commas)", () => {
    expect(parseHotwordInput("Claude Code")).toEqual(["Claude Code"]);
  });

  it("splits ASCII-comma-separated entries", () => {
    expect(parseHotwordInput("CLaude Code, Claude|10, Deepseek, Anthropic|8")).toEqual([
      "CLaude Code",
      "Claude|10",
      "Deepseek",
      "Anthropic|8",
    ]);
  });

  it("splits full-width-comma-separated entries", () => {
    expect(parseHotwordInput("流式输出，语音输入")).toEqual(["流式输出", "语音输入"]);
  });

  it("splits a mix of ASCII and full-width commas", () => {
    expect(parseHotwordInput("Claude，Anthropic|8, GLM")).toEqual(["Claude", "Anthropic|8", "GLM"]);
  });

  it("trims whitespace around each entry", () => {
    expect(parseHotwordInput("  Claude  ,  Anthropic  ")).toEqual(["Claude", "Anthropic"]);
  });

  it("drops empty segments (leading/trailing/double commas)", () => {
    expect(parseHotwordInput(", Claude, , Anthropic,")).toEqual(["Claude", "Anthropic"]);
  });

  it("returns [] for blank input", () => {
    expect(parseHotwordInput("   ")).toEqual([]);
    expect(parseHotwordInput(",,,")).toEqual([]);
  });

  it("preserves the |weight suffix within an entry", () => {
    expect(parseHotwordInput("流式输出|5")).toEqual(["流式输出|5"]);
  });
});

describe("mergeHotwords", () => {
  it("appends new entries in input order", () => {
    expect(mergeHotwords(["Claude"], ["Anthropic", "GLM"])).toEqual(["Claude", "Anthropic", "GLM"]);
  });

  it("drops entries already present (exact match)", () => {
    expect(mergeHotwords(["Claude", "GLM"], ["Claude", "Anthropic"])).toEqual([
      "Claude",
      "GLM",
      "Anthropic",
    ]);
  });

  it("drops duplicates within the new entries themselves", () => {
    expect(mergeHotwords([], ["Claude", "Claude", "Anthropic"])).toEqual(["Claude", "Anthropic"]);
  });

  it("is case-sensitive (Claude != claude)", () => {
    expect(mergeHotwords(["Claude"], ["claude"])).toEqual(["Claude", "claude"]);
  });

  it("returns the original list when no new entries", () => {
    expect(mergeHotwords(["Claude"], [])).toEqual(["Claude"]);
  });
});
