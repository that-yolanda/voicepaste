import { describe, expect, test } from "vitest";
import { errText } from "@/i18n/errText";

describe("errText", () => {
  test("passes plain strings through unchanged", () => {
    // Not-yet-migrated domains and legacy history entries stay verbatim.
    expect(errText("配置格式错误：xxx")).toBe("配置格式错误：xxx");
  });

  test("translates a structured AppError through the locale file", () => {
    expect(errText({ code: "feedback.too_large" })).toBe(
      "附件过大：日志上限 512 KiB，单张截图上限 2 MiB，附件合计上限 3 MiB。",
    );
  });

  test("appends detail with a localized separator", () => {
    expect(errText({ code: "feedback.rate_limited", detail: "HTTP 429" })).toBe(
      "提交过于频繁，请等待 10 分钟后重试。：HTTP 429",
    );
  });

  test("degrades unknown codes to the raw code, never the key", () => {
    expect(errText({ code: "llm.not_yet_migrated" })).toBe("llm.not_yet_migrated");
  });

  test("stringifies other values", () => {
    expect(errText(null)).toBe("null");
    expect(errText(undefined)).toBe("undefined");
    expect(errText(42)).toBe("42");
    expect(errText({})).toBe("[object Object]");
  });
});
