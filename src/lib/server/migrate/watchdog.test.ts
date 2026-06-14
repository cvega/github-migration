import { afterEach, describe, expect, test } from "bun:test";
import type { Counts } from "$lib/types";
import { isLargeRepo, loadWatchdogConfig, progressSignal, type WatchdogConfig } from "./watchdog";

function counts(over: Partial<Counts> = {}): Counts {
  return { commits: 0, branches: 0, tags: 0, issues: 0, pullRequests: 0, releases: 0, ...over };
}

const cfg: WatchdogConfig = {
  enabled: true,
  stallMs: 30 * 60_000,
  maxRestarts: 1,
  maxSizeKb: 100 * 1024,
  maxCommits: 50_000,
  maxIssues: 5_000,
  maxPrs: 5_000,
};

describe("isLargeRepo", () => {
  test("small repo on every dimension is not large", () => {
    expect(isLargeRepo(cfg, { sizeKb: 1024, counts: counts({ commits: 100 }) })).toBe(false);
  });

  test("disk size at the cap is large (>=)", () => {
    expect(isLargeRepo(cfg, { sizeKb: cfg.maxSizeKb, counts: null })).toBe(true);
    expect(isLargeRepo(cfg, { sizeKb: cfg.maxSizeKb - 1, counts: null })).toBe(false);
  });

  test("commits at the cap is large", () => {
    expect(isLargeRepo(cfg, { sizeKb: null, counts: counts({ commits: cfg.maxCommits }) })).toBe(
      true,
    );
  });

  test("issues at the cap is large", () => {
    expect(isLargeRepo(cfg, { sizeKb: null, counts: counts({ issues: cfg.maxIssues }) })).toBe(
      true,
    );
  });

  test("PRs at the cap is large", () => {
    expect(isLargeRepo(cfg, { sizeKb: null, counts: counts({ pullRequests: cfg.maxPrs }) })).toBe(
      true,
    );
  });

  test("null size and null counts is not large (unknown never counts)", () => {
    expect(isLargeRepo(cfg, { sizeKb: null, counts: null })).toBe(false);
  });
});

describe("progressSignal", () => {
  test("sums all resource counts plus repo existence", () => {
    expect(progressSignal(true, counts({ commits: 5, issues: 2 }))).toBe(1 + 5 + 2);
  });

  test("repoExists contributes exactly 1", () => {
    expect(progressSignal(true, counts())).toBe(1);
    expect(progressSignal(false, counts())).toBe(0);
  });

  test("is monotonic: more work yields a higher signal", () => {
    const a = progressSignal(true, counts({ commits: 10 }));
    const b = progressSignal(true, counts({ commits: 11 }));
    expect(b).toBeGreaterThan(a);
  });
});

describe("loadWatchdogConfig", () => {
  const watchdogEnvKeys = [
    "WATCHDOG_ENABLED",
    "WATCHDOG_STALL_MINUTES",
    "WATCHDOG_MAX_RESTARTS",
    "WATCHDOG_MAX_SIZE_MB",
    "WATCHDOG_MAX_COMMITS",
    "WATCHDOG_MAX_ISSUES",
    "WATCHDOG_MAX_PRS",
  ];
  afterEach(() => {
    for (const k of watchdogEnvKeys) delete process.env[k];
  });

  test("applies safe defaults when no env vars are set", () => {
    const c = loadWatchdogConfig();
    expect(c.enabled).toBe(true);
    expect(c.stallMs).toBe(30 * 60_000);
    expect(c.maxRestarts).toBe(1);
    expect(c.maxSizeKb).toBe(100 * 1024);
    expect(c.maxCommits).toBe(50_000);
  });

  test("parses overrides and converts minutes/MB to ms/KB", () => {
    process.env.WATCHDOG_STALL_MINUTES = "10";
    process.env.WATCHDOG_MAX_SIZE_MB = "50";
    process.env.WATCHDOG_MAX_RESTARTS = "3";
    const c = loadWatchdogConfig();
    expect(c.stallMs).toBe(10 * 60_000);
    expect(c.maxSizeKb).toBe(50 * 1024);
    expect(c.maxRestarts).toBe(3);
  });

  test("WATCHDOG_ENABLED accepts 1/true and false", () => {
    process.env.WATCHDOG_ENABLED = "false";
    expect(loadWatchdogConfig().enabled).toBe(false);
    process.env.WATCHDOG_ENABLED = "1";
    expect(loadWatchdogConfig().enabled).toBe(true);
    process.env.WATCHDOG_ENABLED = "true";
    expect(loadWatchdogConfig().enabled).toBe(true);
  });

  test("falls back to default for invalid/negative numeric env", () => {
    process.env.WATCHDOG_MAX_RESTARTS = "not-a-number";
    expect(loadWatchdogConfig().maxRestarts).toBe(1);
    process.env.WATCHDOG_MAX_COMMITS = "-5";
    expect(loadWatchdogConfig().maxCommits).toBe(50_000);
  });
});
