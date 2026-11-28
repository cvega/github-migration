import { describe, expect, test } from "bun:test";
import type { RepoSignals, StoredRepoProfile } from "../types";
import { estimateDuration } from "./duration";

function signals(diskUsageKb: number | null): RepoSignals {
  return {
    name: "r",
    nameWithOwner: "o/r",
    visibility: "PRIVATE",
    isArchived: false,
    isFork: false,
    isEmpty: false,
    diskUsageKb,
    hasWiki: false,
    hasIssues: true,
    hasProjects: false,
    hasDiscussions: false,
    hasPages: false,
    defaultBranch: "main",
    pushedAt: null,
    updatedAt: null,
    issuesCount: 0,
    pullRequestsCount: 0,
    branchesCount: 0,
    tagsCount: 0,
    commitsCount: 0,
    discussionsCount: 0,
    projectsV2Count: 0,
    environmentsCount: 0,
    releasesCount: 0,
    stargazerCount: 0,
    watcherCount: 0,
    forkCount: 0,
    rulesetCount: 0,
    branchProtectionRuleCount: 0,
    branchProtectionRulesUsingUnmigratedFeatures: 0,
    packagesCount: 0,
    usesLfs: false,
    releaseAssetBytes: 0,
    releaseAssetScanComplete: true,
    branchRuleScanComplete: true,
    workflowFileCount: 0,
    webhooksCount: 0,
    hasCodeScanningAlerts: false,
    collaboratorsCount: 0,
    tagProtectionCount: 0,
  };
}

function repo(diskUsageKb: number | null): StoredRepoProfile {
  return {
    nameWithOwner: "o/r",
    signals: signals(diskUsageKb),
    blockers: 0,
    warnings: 0,
    infos: 0,
    catalogMatches: [],
  };
}

const MIB = 1024;
const GIB = 1024 * 1024;

describe("estimateDuration", () => {
  test("buckets boundary sizes into the higher band", () => {
    expect(
      estimateDuration([repo(50 * MIB), repo(100 * MIB), repo(1 * GIB), repo(5 * GIB)]).bandCounts,
    ).toEqual({ S: 1, M: 1, L: 1, XL: 1 });
  });

  test("treats unknown disk usage as the smallest band", () => {
    expect(estimateDuration([repo(null)]).bandCounts).toEqual({ S: 1, M: 0, L: 0, XL: 0 });
  });

  test("sums per-repository hours", () => {
    const estimate = estimateDuration([
      repo(50 * MIB),
      repo(500 * MIB),
      repo(3 * GIB),
      repo(10 * GIB),
    ]);
    expect(estimate.totalRepoHoursLow).toBeCloseTo(3.1, 5);
    expect(estimate.totalRepoHoursHigh).toBeCloseTo(9, 5);
  });

  test("reports zero work and the queue parallelism for an empty run", () => {
    expect(estimateDuration([])).toEqual({
      bandCounts: { S: 0, M: 0, L: 0, XL: 0 },
      totalRepoHoursLow: 0,
      totalRepoHoursHigh: 0,
      defaultParallelism: 10,
    });
  });
});
