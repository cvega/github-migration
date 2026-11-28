import { describe, expect, test } from "bun:test";
import type { RepoSignals } from "../types";
import { deriveInsights, STALE_MONTHS } from "./insights";

const NOW = Date.parse("2026-06-13T00:00:00Z");

function monthsAgo(months: number): string {
  return new Date(NOW - months * 30 * 24 * 60 * 60 * 1000).toISOString();
}

function signals(overrides: Partial<RepoSignals> = {}): RepoSignals {
  return {
    name: "widget",
    nameWithOwner: "acme/widget",
    visibility: "PRIVATE",
    isArchived: false,
    isFork: false,
    isEmpty: false,
    diskUsageKb: 100,
    hasWiki: false,
    hasIssues: true,
    hasProjects: false,
    hasDiscussions: false,
    hasPages: false,
    defaultBranch: "main",
    pushedAt: monthsAgo(1),
    updatedAt: monthsAgo(1),
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
    ...overrides,
  };
}

describe("deriveInsights", () => {
  test("keeps active repositories quiet", () => {
    expect(deriveInsights(signals(), NOW)).toEqual([]);
  });

  test("classifies archived and stale repositories", () => {
    expect(deriveInsights(signals({ isArchived: true }), NOW)[0]).toMatchObject({
      id: "archived-move-now",
      tone: "opportunity",
    });
    expect(deriveInsights(signals({ pushedAt: monthsAgo(STALE_MONTHS) }), NOW)[0]).toMatchObject({
      id: "stale-confirm",
      tone: "caution",
    });
  });

  test("suppresses redundant stale insight for archived repositories", () => {
    expect(
      deriveInsights(signals({ isArchived: true, pushedAt: monthsAgo(36) }), NOW),
    ).toHaveLength(1);
  });

  test("short-circuits all other insight classes for empty repositories", () => {
    expect(
      deriveInsights(signals({ isEmpty: true, isArchived: true, pushedAt: monthsAgo(36) }), NOW),
    ).toEqual([expect.objectContaining({ id: "empty-repo", tone: "note" })]);
  });

  test("does not treat missing or future activity as stale", () => {
    expect(deriveInsights(signals({ pushedAt: null }), NOW)).toEqual([]);
    expect(
      deriveInsights(signals({ pushedAt: new Date(NOW + 24 * 60 * 60 * 1000).toISOString() }), NOW),
    ).toEqual([]);
  });
});
