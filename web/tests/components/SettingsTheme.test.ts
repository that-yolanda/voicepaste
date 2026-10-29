import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const script = readFileSync(`${process.cwd()}/web/public/settings-theme.js`, "utf8");

function firstTheme(native: unknown, cached: unknown, systemDark: boolean, storageFails = false) {
  const dataset: Record<string, string> = {};
  runInNewContext(script, {
    window: { __VOICEPASTE_THEME__: native },
    document: { documentElement: { dataset } },
    localStorage: {
      getItem: () => {
        if (storageFails) throw new Error("unavailable");
        return cached;
      },
    },
    matchMedia: () => ({ matches: systemDark }),
  });
  return dataset;
}

describe("settings theme before React mounts", () => {
  it.each([
    ["dark", "light", false, "dark"],
    ["light", "dark", true, "light"],
    ["system", "dark", false, "light"],
    ["system", "light", true, "dark"],
    [undefined, "light", true, "light"],
    [undefined, "invalid", true, "dark"],
  ])("resolves native %s, cache %s, system dark %s to %s", (native, cached, dark, expected) => {
    expect(firstTheme(native, cached, dark).theme).toBe(expected);
  });

  it("still follows the system when storage is unavailable", () => {
    expect(firstTheme(undefined, undefined, false, true)).toEqual({
      theme: "light",
      themePreference: "system",
    });
  });
});
