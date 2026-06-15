import { describe, expect, test } from "bun:test";
import { formatDateTime, formatElapsed, formatHours, formatRepoSize, timeAgo } from "./format";

describe("formatElapsed", () => {
  test("returns the fallback for null", () => {
    expect(formatElapsed(null)).toBe("—");
    expect(formatElapsed(null, "n/a")).toBe("n/a");
  });

  test("formats sub-minute durations as seconds", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(45)).toBe("45s");
  });

  test("formats minute-and-second durations", () => {
    expect(formatElapsed(90)).toBe("1m 30s");
    expect(formatElapsed(125)).toBe("2m 5s");
  });

  test("formats hour-and-minute durations, dropping seconds", () => {
    expect(formatElapsed(3600)).toBe("1h 0m");
    expect(formatElapsed(3661)).toBe("1h 1m");
    expect(formatElapsed(7200)).toBe("2h 0m");
  });
});

describe("formatHours", () => {
  test("returns the fallback for null or non-positive input", () => {
    expect(formatHours(null)).toBe("—");
    expect(formatHours(0)).toBe("—");
    expect(formatHours(-1)).toBe("—");
    expect(formatHours(null, "n/a")).toBe("n/a");
  });

  test("formats sub-hour durations as minutes", () => {
    expect(formatHours(0.1)).toBe("6 min");
    expect(formatHours(0.5)).toBe("30 min");
  });

  test("formats hour-and-minute durations under a day", () => {
    expect(formatHours(1)).toBe("1h");
    expect(formatHours(1.5)).toBe("1h 30m");
    expect(formatHours(23.5)).toBe("23h 30m");
  });

  test("formats multi-day durations as days and hours", () => {
    expect(formatHours(24)).toBe("1d");
    expect(formatHours(25)).toBe("1d 1h");
    expect(formatHours(49)).toBe("2d 1h");
  });
});

describe("formatRepoSize", () => {
  test("returns the fallback for null/undefined", () => {
    expect(formatRepoSize(null)).toBe("—");
    expect(formatRepoSize(undefined)).toBe("—");
    expect(formatRepoSize(null, "n/a")).toBe("n/a");
  });

  test("formats kilobytes below 1 MB", () => {
    expect(formatRepoSize(512)).toBe("512 KB");
    expect(formatRepoSize(1023)).toBe("1023 KB");
  });

  test("formats megabytes with one decimal below 10 and rounded above", () => {
    expect(formatRepoSize(1024)).toBe("1.0 MB");
    expect(formatRepoSize(1536)).toBe("1.5 MB");
    expect(formatRepoSize(10240)).toBe("10 MB");
  });

  test("formats gigabytes", () => {
    expect(formatRepoSize(1024 * 1024)).toBe("1.0 GB");
    expect(formatRepoSize(1024 * 1024 * 10)).toBe("10 GB");
  });
});

describe("formatDateTime", () => {
  test("returns the fallback for empty/invalid input", () => {
    expect(formatDateTime(null)).toBe("—");
    expect(formatDateTime(undefined)).toBe("—");
    expect(formatDateTime("")).toBe("—");
    expect(formatDateTime("not-a-date")).toBe("—");
    expect(formatDateTime(null, "n/a")).toBe("n/a");
  });

  test("formats a valid ISO timestamp into a non-empty localized string", () => {
    const out = formatDateTime("2026-06-08T15:42:00.000Z");
    expect(out).not.toBe("—");
    expect(out).toContain("2026");
  });
});

describe("timeAgo", () => {
  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

  test("returns 'just now' for sub-minute ages", () => {
    expect(timeAgo(iso(0))).toBe("just now");
    expect(timeAgo(iso(30_000))).toBe("just now");
  });

  test("formats minutes", () => {
    expect(timeAgo(iso(5 * 60_000))).toBe("5m ago");
    expect(timeAgo(iso(59 * 60_000))).toBe("59m ago");
  });

  test("formats hours", () => {
    expect(timeAgo(iso(3 * 3_600_000))).toBe("3h ago");
  });

  test("formats days", () => {
    expect(timeAgo(iso(2 * 86_400_000))).toBe("2d ago");
  });
});
