import { beforeAll, describe, expect, it } from "vitest";
import "./helpers/setup-app.js";
import fs from "node:fs";
import vm from "node:vm";

const appCode = fs.readFileSync("./web/app.js", "utf-8");

beforeAll(() => {
  // Execute app.js so its top-level functions become accessible in this context
  vm.runInThisContext(appCode);
});

describe("floatTo16BitPCM", () => {
  it("converts zero to zero", () => {
    const input = new Float32Array([0.0, 0.0, 0.0]);
    const result = floatTo16BitPCM(input);
    expect(result[0]).toBe(0);
    expect(result[1]).toBe(0);
    expect(result[2]).toBe(0);
  });

  it("converts positive 1.0 to max int16", () => {
    const input = new Float32Array([1.0]);
    const result = floatTo16BitPCM(input);
    expect(result[0]).toBe(0x7fff);
  });

  it("converts negative -1.0 to min int16", () => {
    const input = new Float32Array([-1.0]);
    const result = floatTo16BitPCM(input);
    expect(result[0]).toBe(-0x8000);
  });

  it("converts 0.5 correctly", () => {
    const input = new Float32Array([0.5]);
    const result = floatTo16BitPCM(input);
    expect(result[0]).toBeCloseTo(0x3fff, -1);
  });

  it("converts -0.5 correctly", () => {
    const input = new Float32Array([-0.5]);
    const result = floatTo16BitPCM(input);
    expect(result[0]).toBeCloseTo(-0x4000, -1);
  });

  it("clamps values above 1.0", () => {
    const input = new Float32Array([2.0, 100.0]);
    const result = floatTo16BitPCM(input);
    expect(result[0]).toBe(0x7fff);
    expect(result[1]).toBe(0x7fff);
  });

  it("clamps values below -1.0", () => {
    const input = new Float32Array([-2.0, -100.0]);
    const result = floatTo16BitPCM(input);
    expect(result[0]).toBe(-0x8000);
    expect(result[1]).toBe(-0x8000);
  });

  it("handles multiple samples", () => {
    const input = new Float32Array([0.0, 0.25, 0.5, 0.75, 1.0]);
    const result = floatTo16BitPCM(input);
    expect(result.length).toBe(5);
    expect(result[0]).toBe(0);
    // Values should increase
    expect(result[4]).toBeGreaterThan(result[2]);
    expect(result[2]).toBeGreaterThan(result[0]);
  });

  it("returns empty buffer for empty input", () => {
    const input = new Float32Array([]);
    const result = floatTo16BitPCM(input);
    expect(result.length).toBe(0);
  });
});

describe("downsampleBuffer", () => {
  it("returns same buffer when rates match", () => {
    const input = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    const result = downsampleBuffer(input, 16000, 16000);
    expect(result).toEqual(input);
  });

  it("downsamples 2x ratio", () => {
    const input = new Float32Array([1.0, 2.0, 3.0, 4.0]);
    const result = downsampleBuffer(input, 44100, 22050);
    expect(result.length).toBe(2);
    // First result: average of first two samples
    expect(result[0]).toBeCloseTo(1.5, 5);
    // Second result: average of last two samples
    expect(result[1]).toBeCloseTo(3.5, 5);
  });

  it("downsamples from 44100 to 16000", () => {
    const input = new Float32Array(4410).fill(0.5);
    const result = downsampleBuffer(input, 44100, 16000);
    expect(result.length).toBe(1600);
    // Average should still be ~0.5
    const avg = result.reduce((a, b) => a + b, 0) / result.length;
    expect(avg).toBeCloseTo(0.5, 5);
  });

  it("handles single sample input", () => {
    const input = new Float32Array([0.5]);
    const result = downsampleBuffer(input, 44100, 22050);
    expect(result.length).toBe(1);
    expect(result[0]).toBeCloseTo(0.5, 5);
  });
});

describe("int16ToBase64", () => {
  it("converts int16 array to base64 string", () => {
    const input = new Int16Array([0x41, 0x42, 0x43]); // 'A', 'B', 'C' in ASCII
    const result = int16ToBase64(input);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("produces valid base64", () => {
    const input = new Int16Array([0, 1, 2, 3]);
    const result = int16ToBase64(input);
    // Base64 only contains A-Z, a-z, 0-9, +, /, =
    expect(result).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it("handles empty array", () => {
    const input = new Int16Array([]);
    const result = int16ToBase64(input);
    expect(result).toBe("");
  });
});

describe("resolvedGlassVariant", () => {
  it('returns "light" when theme is "light"', () => {
    currentAppearance.theme = "light";
    expect(resolvedGlassVariant()).toBe("light");
  });

  it('returns "dark" when theme is "dark"', () => {
    currentAppearance.theme = "dark";
    expect(resolvedGlassVariant()).toBe("dark");
  });

  it('returns "dark" when system prefers dark', () => {
    currentAppearance.theme = "system";
    window.matchMedia.mockReturnValue({ matches: true });
    expect(resolvedGlassVariant()).toBe("dark");
  });

  it('returns "light" when system prefers light', () => {
    currentAppearance.theme = "system";
    window.matchMedia.mockReturnValue({ matches: false });
    expect(resolvedGlassVariant()).toBe("light");
  });
});

describe("getVisibleHintText", () => {
  it('returns "Preparing…" when connecting (English)', () => {
    state.appState = "recording";
    state.audioReady = false;
    // isZhLocale is initialized from navigator.language at module level
    // We set it to "en-US" in setup
    expect(getVisibleHintText()).toBe("Preparing…");
  });

  it('returns "Thinking…" when finishing with progress variant (English)', () => {
    state.appState = "finishing";
    state.hintVariant = "progress";
    state.audioReady = true;
    expect(getVisibleHintText()).toBe("Thinking…");
  });

  it("returns hintText when idle and hintText is set", () => {
    state.appState = "idle";
    state.audioReady = true;
    state.hintText = "Press F13 to start";
    state.hintVariant = "text";
    expect(getVisibleHintText()).toBe("Press F13 to start");
  });

  it("returns empty string when no hint", () => {
    state.appState = "idle";
    state.audioReady = true;
    state.hintText = "";
    state.hintVariant = "text";
    expect(getVisibleHintText()).toBe("");
  });
});

describe("shouldShowHint", () => {
  it("returns true when hint text is available", () => {
    state.appState = "recording";
    state.audioReady = false;
    expect(shouldShowHint()).toBe(true);
  });

  it("returns false when no hint text", () => {
    state.appState = "idle";
    state.audioReady = true;
    state.hintText = "";
    state.hintVariant = "text";
    expect(shouldShowHint()).toBe(false);
  });
});
