import { describe, expect, it } from "vitest";

import { parseInlineTokens, parseMarkdownBlocks } from "@/settings/lib/markdown";

describe("parseMarkdownBlocks", () => {
  it("parses headings, paragraphs, and list blocks with source line numbers", () => {
    const notes = [
      "本次更新新增语音识别,并优化快捷键体验。",
      "",
      "### 新功能与体验优化",
      "- **语音识别** — 支持实时转写。",
      "- **快捷键** — 默认唤醒键更易触达。",
      "",
      "### Fix",
      "- 修复录制快捷键无法捕获按键的问题。",
    ].join("\n");

    expect(parseMarkdownBlocks(notes)).toEqual([
      { type: "paragraph", text: "本次更新新增语音识别,并优化快捷键体验。", line: 1 },
      { type: "heading", text: "新功能与体验优化", line: 3 },
      {
        type: "list",
        line: 4,
        items: [
          { text: "**语音识别** — 支持实时转写。", line: 4 },
          { text: "**快捷键** — 默认唤醒键更易触达。", line: 5 },
        ],
      },
      { type: "heading", text: "Fix", line: 7 },
      {
        type: "list",
        line: 8,
        items: [{ text: "修复录制快捷键无法捕获按键的问题。", line: 8 }],
      },
    ]);
  });

  it("splits non-adjacent lists into separate blocks", () => {
    expect(parseMarkdownBlocks("- 第一项\n\n中间段落\n\n- 第二项")).toEqual([
      { type: "list", line: 1, items: [{ text: "第一项", line: 1 }] },
      { type: "paragraph", text: "中间段落", line: 3 },
      { type: "list", line: 5, items: [{ text: "第二项", line: 5 }] },
    ]);
  });

  it("keeps a list block's line at its first item when items span lines", () => {
    const blocks = parseMarkdownBlocks("- 甲\n- 乙");
    expect(blocks).toEqual([
      {
        type: "list",
        line: 1,
        items: [
          { text: "甲", line: 1 },
          { text: "乙", line: 2 },
        ],
      },
    ]);
    expect(blocks[0].type === "list" && blocks[0].line).toBe(1);
  });

  it("returns empty array for empty or blank input", () => {
    expect(parseMarkdownBlocks("")).toEqual([]);
    expect(parseMarkdownBlocks("  \n \n")).toEqual([]);
  });

  it("treats unsupported table rows as plain paragraphs", () => {
    expect(parseMarkdownBlocks("| 平台 | 下载 |\n|------|------|")).toEqual([
      { type: "paragraph", text: "| 平台 | 下载 |", line: 1 },
      { type: "paragraph", text: "|------|------|", line: 2 },
    ]);
  });
});

describe("parseInlineTokens", () => {
  it("splits bold and code spans from plain text with offsets", () => {
    expect(parseInlineTokens("按 **全局主键** 或 `Enter` 输出")).toEqual([
      { type: "text", text: "按 ", start: 0 },
      { type: "bold", text: "全局主键", start: 4 },
      { type: "text", text: " 或 ", start: 10 },
      { type: "code", text: "Enter", start: 14 },
      { type: "text", text: " 输出", start: 20 },
    ]);
  });

  it("gives duplicate tokens distinct offsets so keys stay unique", () => {
    expect(parseInlineTokens("**重试** 与 **重试**")).toEqual([
      { type: "bold", text: "重试", start: 2 },
      { type: "text", text: " 与 ", start: 6 },
      { type: "bold", text: "重试", start: 11 },
    ]);
  });

  it("returns a single text token for plain strings", () => {
    expect(parseInlineTokens("没有任何标记")).toEqual([
      { type: "text", text: "没有任何标记", start: 0 },
    ]);
  });

  it("keeps unclosed markers as literal text", () => {
    expect(parseInlineTokens("**未闭合加粗")).toEqual([
      { type: "text", text: "**未闭合加粗", start: 0 },
    ]);
    expect(parseInlineTokens("单个 ` 反引号")).toEqual([
      { type: "text", text: "单个 ` 反引号", start: 0 },
    ]);
  });
});
