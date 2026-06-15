/**
 * Tests for the insights engine. Pure signal → recommendation mapping, so these
 * use plain fixtures and an injected clock for deterministic staleness.
 */
import { describe, expect, test } from "bun:test";
import { deriveInsights, STALE_MONTHS } from "./insights";
import type { RepoSignals } from "./types";

const NOW = Date.parse("2026-06-13T00:00:00Z");

/** Months before NOW as an ISO string. */
function monthsAgo(n: number): string {
  return new Date(NOW - n * 30 * 24 * 60 * 60 * 1000).toISOString();
}

function signals(over: Partial<RepoSignals> = {}): RepoSignals {
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
    defaultBranch: "main",
    pushedAt: monthsAgo(1),
    updatedAt: monthsAgo(1),
    issuesCount: 0,
    pullRequestsCount: 0,
    branchesCount: 0,
    tagsCount: 0,
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
    workflowFileCount: 0,
    ...over,
  };
}

const ids = (s: RepoSignals) => deriveInsights(s, NOW).map((i) => i.id);

describe("deriveInsights", () => {
  test("an active, non-archived, non-empty repo yields no insights", () => {
    expect(deriveInsights(signals({ pushedAt: monthsAgo(2) }), NOW)).toEqual([]);
  });

  test("flags an archived repo as a move-now opportunity", () => {
    const [insight] = deriveInsights(signals({ isArchived: true }), NOW);
    expect(insight).toMatchObject({ id: "archived-move-now", tone: "opportunity" });
  });

  test("flags a repo with no push in >= STALE_MONTHS as a caution", () => {
    const [insight] = deriveInsights(signals({ pushedAt: monthsAgo(STALE_MONTHS) }), NOW);
    expect(insight).toMatchObject({ id: "stale-confirm", tone: "caution" });
    expect(insight?.detail).toContain(`${STALE_MONTHS} months`);
  });

  test("does not flag a repo pushed just under the stale threshold", () => {
    expect(ids(signals({ pushedAt: monthsAgo(STALE_MONTHS - 1) }))).not.toContain("stale-confirm");
  });

  test("suppresses the stale caution for an archived repo (redundant)", () => {
    const result = ids(signals({ isArchived: true, pushedAt: monthsAgo(36) }));
    expect(result).toContain("archived-move-now");
    expect(result).not.toContain("stale-confirm");
  });

  test("notes an empty repo and nothing else", () => {
    // Empty short-circuits even when archived + stale would otherwise apply.
    const result = deriveInsights(
      signals({ isEmpty: true, isArchived: true, pushedAt: monthsAgo(36) }),
      NOW,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "empty-repo", tone: "note" });
  });

  test("a repo never pushed (null) is not flagged stale", () => {
    expect(ids(signals({ pushedAt: null }))).not.toContain("stale-confirm");
  });

  test("a future pushedAt is treated as 0 months (not negative/stale)", () => {
    const future = new Date(NOW + 5 * 24 * 60 * 60 * 1000).toISOString();
    expect(ids(signals({ pushedAt: future }))).toEqual([]);
  });

  test("every insight carries a non-empty label and detail", () => {
    for (const s of [
      signals({ isArchived: true }),
      signals({ pushedAt: monthsAgo(24) }),
      signals({ isEmpty: true }),
    ]) {
      for (const insight of deriveInsights(s, NOW)) {
        expect(insight.label.trim().length, insight.id).toBeGreaterThan(0);
        expect(insight.detail.trim().length, insight.id).toBeGreaterThan(0);
      }
    }
  });
});
