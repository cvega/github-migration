/**
 * Tests for the size-band duration estimate. Pure and deterministic — only a
 * repo's disk usage drives its band, so these pin the band thresholds, the
 * summed per-repo hours, and the default parallelism.
 */
import { describe, expect, test } from "bun:test";
import { estimateDuration } from "./estimate";
import { makeDiscoveredRepo, makeRepoSignals } from "./test-factories";
import type { RepoSignals, StoredRepoProfile } from "./types";

/** A full RepoSignals where only disk usage matters for the estimate. */
function signals(diskUsageKb: number | null): RepoSignals {
  return makeRepoSignals(makeDiscoveredRepo("r", { nameWithOwner: "o/r", diskUsageKb }));
}

function repo(diskUsageKb: number | null): StoredRepoProfile {
  return {
    nameWithOwner: "o/r",
    signals: signals(diskUsageKb),
    blockers: 0,
    warnings: 0,
    infos: 0,
    applyingConsiderations: [],
  };
}

const MIB = 1024;
const GIB = 1024 * 1024;

describe("estimateDuration", () => {
  test("buckets repos into size bands by disk usage", () => {
    const est = estimateDuration([
      repo(50 * MIB), // S  (< 100 MiB)
      repo(500 * MIB), // M  (< 1 GiB)
      repo(3 * GIB), // L  (< 5 GiB)
      repo(10 * GIB), // XL (≥ 5 GiB)
    ]);
    expect(est.bandCounts).toEqual({ S: 1, M: 1, L: 1, XL: 1 });
  });

  test("treats a null disk usage as the smallest band", () => {
    const est = estimateDuration([repo(null)]);
    expect(est.bandCounts).toEqual({ S: 1, M: 0, L: 0, XL: 0 });
  });

  test("puts boundary sizes in the higher band (thresholds are exclusive)", () => {
    const est = estimateDuration([
      repo(100 * MIB), // exactly 100 MiB → M, not S
      repo(1 * GIB), // exactly 1 GiB → L, not M
      repo(5 * GIB), // exactly 5 GiB → XL, not L
    ]);
    expect(est.bandCounts).toEqual({ S: 0, M: 1, L: 1, XL: 1 });
  });

  test("sums per-repo hours across all repos", () => {
    // One of each band: low = 0.1+0.25+0.75+2, high = 0.25+0.75+2+6.
    const est = estimateDuration([repo(50 * MIB), repo(500 * MIB), repo(3 * GIB), repo(10 * GIB)]);
    expect(est.totalRepoHoursLow).toBeCloseTo(3.1, 5);
    expect(est.totalRepoHoursHigh).toBeCloseTo(9.0, 5);
  });

  test("an empty run estimates zero work", () => {
    const est = estimateDuration([]);
    expect(est.bandCounts).toEqual({ S: 0, M: 0, L: 0, XL: 0 });
    expect(est.totalRepoHoursLow).toBe(0);
    expect(est.totalRepoHoursHigh).toBe(0);
  });

  test("reports the default parallelism (the migrate queue cap)", () => {
    expect(estimateDuration([]).defaultParallelism).toBe(10);
  });
});
