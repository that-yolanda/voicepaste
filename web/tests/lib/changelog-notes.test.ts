import { describe, expect, it } from "vitest";

import { buildBilingualNotes, extractChangelogSection } from "../../../scripts/changelog-notes";

const CHANGELOG = [
  "# 更新说明",
  "",
  "## v1.2.0 (2026-01-02)",
  "第二个版本的段落。",
  "### 优化",
  "- 优化项 A",
  "",
  "## v1.1.0 (2026-01-01)",
  "第一个版本的段落。",
  "",
].join("\n");

describe("extractChangelogSection", () => {
  it("extracts the section body between version headings", () => {
    expect(extractChangelogSection(CHANGELOG, "1.2.0")).toBe(
      "第二个版本的段落。\n### 优化\n- 优化项 A",
    );
    expect(extractChangelogSection(CHANGELOG, "1.1.0")).toBe("第一个版本的段落。");
  });

  it("matches headings with or without the v prefix", () => {
    const content = "## 1.2.0\n无前缀也能匹配。";
    expect(extractChangelogSection(content, "1.2.0")).toBe("无前缀也能匹配。");
  });

  it("returns an empty string for a missing version", () => {
    expect(extractChangelogSection(CHANGELOG, "9.9.9")).toBe("");
  });

  it("stops at the first heading of the following section", () => {
    const blocks = extractChangelogSection(CHANGELOG, "1.2.0");
    expect(blocks).not.toContain("第一个版本");
  });
});

describe("buildBilingualNotes", () => {
  it("JSON-encodes both languages into a single manifest string", () => {
    const notes = buildBilingualNotes("中文说明。", "English notes.");
    expect(notes).toBe('{"zh":"中文说明。","en":"English notes."}');
    expect(JSON.parse(notes)).toEqual({ zh: "中文说明。", en: "English notes." });
  });

  it("keeps a missing language as an empty field so the app can fall back", () => {
    expect(JSON.parse(buildBilingualNotes("仅中文。", ""))).toEqual({ zh: "仅中文。", en: "" });
    expect(JSON.parse(buildBilingualNotes("", "English only."))).toEqual({
      zh: "",
      en: "English only.",
    });
  });

  it("returns an empty string when neither language has content", () => {
    expect(buildBilingualNotes("", "")).toBe("");
  });
});
