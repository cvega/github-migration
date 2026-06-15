/**
 * Tests for the consideration-analysis engine. These pin the three-way
 * classification (applies / clear / indeterminate), the evidence strings, the
 * severity roll-up, and an integrity check that every detector targets a real
 * registry consideration — so the engine can't drift from the registry.
 */
import { describe, expect, test } from "bun:test";
import { MIGRATION_CONSIDERATIONS } from "$lib/profile/consideration-registry";
import { analyzeRepo, DETECTED_CONSIDERATION_IDS, type RepoProfile } from "./analyze";
import type { RepoSignals } from "./types";

/** A repo with every gathered signal at its "clean" value. */
function cleanSignals(over: Partial<RepoSignals> = {}): RepoSignals {
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
    pushedAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
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
    branchProtectionRuleCount: 0,
    branchProtectionRulesUsingUnmigratedFeatures: 0,
    packagesCount: 0,
    usesLfs: false,
    ...over,
  };
}

/** Look up a finding by consideration id. */
function finding(profile: RepoProfile, id: string) {
  return profile.findings.find((f) => f.consideration.id === id);
}

describe("analyzeRepo", () => {
  test("produces one finding per registry consideration, in registry order", () => {
    const profile = analyzeRepo(cleanSignals());
    expect(profile.findings).toHaveLength(MIGRATION_CONSIDERATIONS.length);
    expect(profile.findings.map((f) => f.consideration.id)).toEqual(
      MIGRATION_CONSIDERATIONS.map((g) => g.id),
    );
  });

  test("a clean repo: every detectable consideration is clear, nothing applies", () => {
    const profile = analyzeRepo(cleanSignals());
    expect(profile.summary.applies).toBe(0);
    expect(profile.summary.clear).toBe(DETECTED_CONSIDERATION_IDS.length);
    expect(profile.summary.indeterminate).toBe(
      MIGRATION_CONSIDERATIONS.length - DETECTED_CONSIDERATION_IDS.length,
    );
  });

  test("considerations without a detector are reported as indeterminate, not clear", () => {
    const profile = analyzeRepo(cleanSignals());
    // `webhooks` has no signal gathered yet.
    expect(finding(profile, "webhooks")?.status).toBe("indeterminate");
    expect(finding(profile, "discussions")?.status).toBe("clear");
  });

  test("detects every currently-supported consideration with evidence", () => {
    const profile = analyzeRepo(
      cleanSignals({
        discussionsCount: 3,
        projectsV2Count: 1,
        environmentsCount: 2,
        branchProtectionRuleCount: 5,
        branchProtectionRulesUsingUnmigratedFeatures: 2,
        stargazerCount: 40,
        watcherCount: 1,
        isFork: true,
        hasWiki: true,
        packagesCount: 2,
        usesLfs: true,
      }),
    );

    expect(finding(profile, "discussions")).toMatchObject({
      status: "applies",
      evidence: "3 discussions",
    });
    expect(finding(profile, "projects-v2")?.evidence).toBe("1 project");
    expect(finding(profile, "actions-environments")?.evidence).toBe("2 environments");
    expect(finding(profile, "branch-protection-partial")?.evidence).toBe(
      "2 rules using unmigrated features",
    );
    expect(finding(profile, "stars-watchers")?.evidence).toBe("40 stars, 1 watcher");
    expect(finding(profile, "fork-relationships")?.evidence).toBe("repository is a fork");
    expect(finding(profile, "wiki-attachments")?.evidence).toBe(
      "wiki enabled (attachments not migrated)",
    );
    expect(finding(profile, "packages")?.evidence).toBe("2 packages");
    expect(finding(profile, "git-lfs")?.status).toBe("applies");
  });

  test("rolls up applying considerations by severity", () => {
    const profile = analyzeRepo(
      cleanSignals({
        discussionsCount: 1, // warn
        projectsV2Count: 1, // warn
        environmentsCount: 1, // warn
        branchProtectionRulesUsingUnmigratedFeatures: 1, // warn
        stargazerCount: 1, // info
        isFork: true, // info
        hasWiki: true, // info
      }),
    );
    expect(profile.summary.applies).toBe(7);
    expect(profile.summary.warnings).toBe(4);
    expect(profile.summary.infos).toBe(3);
    expect(profile.summary.blockers).toBe(0);
  });

  test("flags an oversized repo as a git-archive-size blocker", () => {
    const big = analyzeRepo(cleanSignals({ diskUsageKb: 3 * 1024 * 1024 })); // ~3 GiB
    const f = finding(big, "git-archive-size-limit");
    expect(f?.status).toBe("applies");
    expect(f?.evidence).toMatch(/3\.0 GiB.*git-sizer/);
    expect(big.summary.blockers).toBe(1);
  });

  test("a repo under the archive proxy threshold is clear of the size blocker", () => {
    const small = analyzeRepo(cleanSignals({ diskUsageKb: 500 * 1024 })); // 500 MiB
    expect(finding(small, "git-archive-size-limit")?.status).toBe("clear");
    expect(small.summary.blockers).toBe(0);
  });

  test("null diskUsage is clear of the size blocker (not a false positive)", () => {
    const unknown = analyzeRepo(cleanSignals({ diskUsageKb: null }));
    expect(finding(unknown, "git-archive-size-limit")?.status).toBe("clear");
  });

  test("branch-protection consideration ignores rules that use only migratable features", () => {
    // Rules exist, but none use an unmigrated feature.
    const profile = analyzeRepo(
      cleanSignals({
        branchProtectionRuleCount: 4,
        branchProtectionRulesUsingUnmigratedFeatures: 0,
      }),
    );
    expect(finding(profile, "branch-protection-partial")?.status).toBe("clear");
  });

  test("stars-watchers applies on watchers alone", () => {
    const profile = analyzeRepo(cleanSignals({ stargazerCount: 0, watcherCount: 5 }));
    expect(finding(profile, "stars-watchers")?.evidence).toBe("0 stars, 5 watchers");
  });

  test("carries the repo identity through", () => {
    const profile = analyzeRepo(cleanSignals({ nameWithOwner: "octo/thing" }));
    expect(profile.nameWithOwner).toBe("octo/thing");
  });
});

describe("DETECTED_CONSIDERATION_IDS integrity", () => {
  test("every detector targets a real registry consideration id", () => {
    const ids = new Set(MIGRATION_CONSIDERATIONS.map((g) => g.id));
    for (const id of DETECTED_CONSIDERATION_IDS) {
      expect(ids.has(id)).toBe(true);
    }
  });

  test("is non-empty (the engine actually evaluates something)", () => {
    expect(DETECTED_CONSIDERATION_IDS.length).toBeGreaterThan(0);
  });
});
