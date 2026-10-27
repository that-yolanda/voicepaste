import { describe, expect, it } from "vitest";

import { pickNotesLanguage } from "@/settings/lib/notes";

const BILINGUAL_NOTES = JSON.stringify({
  zh: "本次更新新增语音识别。",
  en: "This update adds speech recognition.",
});

describe("pickNotesLanguage", () => {
  it("returns the requested language from a bilingual JSON payload", () => {
    expect(pickNotesLanguage(BILINGUAL_NOTES, "zh")).toBe("本次更新新增语音识别。");
    expect(pickNotesLanguage(BILINGUAL_NOTES, "en")).toBe("This update adds speech recognition.");
  });

  it("falls back to the other supported language when the requested one is missing", () => {
    const zhOnly = JSON.stringify({ zh: "仅中文说明。" });
    expect(pickNotesLanguage(zhOnly, "en")).toBe("仅中文说明。");
  });

  it("ignores empty or non-string language entries", () => {
    const payload = JSON.stringify({ zh: "  ", en: "   " });
    expect(pickNotesLanguage(payload, "zh")).toBe("");
    expect(pickNotesLanguage(JSON.stringify({ zh: 42, en: null }), "zh")).toBe("");
  });

  it("returns plain Markdown strings untouched for legacy manifests", () => {
    const plain = "### 新功能\n- **语音识别** — 支持实时转写。";
    expect(pickNotesLanguage(plain, "zh")).toBe(plain);
  });

  it("returns empty string for JSON payloads without language fields", () => {
    expect(pickNotesLanguage(JSON.stringify({ message: "hello" }), "zh")).toBe("");
    expect(pickNotesLanguage(JSON.stringify("hello"), "zh")).toBe("");
  });
});
