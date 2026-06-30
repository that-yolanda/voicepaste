import { describe, expect, it } from "vitest";
import { formatCompact, formatDuration } from "@/settings/lib/format";

describe("formatCompact", () => {
  it("formats numbers < 1000 as-is", () => {
    expect(formatCompact(0)).toBe("0");
    expect(formatCompact(42)).toBe("42");
    expect(formatCompact(999)).toBe("999");
  });
  it("formats thousands with K suffix", () => {
    expect(formatCompact(1000)).toBe("1.0K");
    expect(formatCompact(1500)).toBe("1.5K");
    expect(formatCompact(9999)).toBe("10.0K");
  });
  it("formats millions with M suffix", () => {
    expect(formatCompact(1_000_000)).toBe("1.0M");
    expect(formatCompact(2_500_000)).toBe("2.5M");
  });
});

describe("formatDuration", () => {
  it("formats seconds", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(30)).toBe("30s");
    expect(formatDuration(59)).toBe("59s");
  });
  it("formats minutes", () => {
    expect(formatDuration(60)).toBe("1m");
    expect(formatDuration(90)).toBe("1m");
    expect(formatDuration(120)).toBe("2m");
    expect(formatDuration(3599)).toBe("59m");
  });
  it("formats hours with decimal", () => {
    expect(formatDuration(3600)).toBe("1.0h");
    expect(formatDuration(5400)).toBe("1.5h");
    expect(formatDuration(7200)).toBe("2.0h");
  });
  it("formats >= 10 hours as integer", () => {
    expect(formatDuration(36000)).toBe("10h");
    expect(formatDuration(72000)).toBe("20h");
  });
});
