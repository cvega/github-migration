/**
 * Tests for per-repo GraphQL signal augmentation. The `gql` client is injected,
 * so these exercise the query-variable shaping, field mapping, and — the part
 * with real logic — the branch-protection "uses an unmigrated feature"
 * derivation, all without a network.
 */
import { describe, expect, test } from "bun:test";
import type { graphql } from "@octokit/graphql";
import { augmentRepoSignals } from "./augment";
import type { DiscoveredRepo } from "./types";

/** A discovered repo fixture (the spread input to augmentation). */
function discovered(over: Partial<DiscoveredRepo> = {}): DiscoveredRepo {
  return {
    name: "widget",
    nameWithOwner: "acme/widget",
    visibility: "PRIVATE",
    isArchived: false,
    isFork: false,
    isEmpty: false,
    diskUsageKb: 1234,
    hasWiki: false,
    hasIssues: true,
    hasProjects: false,
    hasDiscussions: true,
    defaultBranch: "main",
    pushedAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    ...over,
  };
}

interface RuleFlags {
  allowsForcePushes?: boolean;
  requiresDeployments?: boolean;
  lockBranch?: boolean;
  blocksCreations?: boolean;
  requireLastPushApproval?: boolean;
  bypassForcePush?: number;
  bypassPullRequest?: number;
}

/** Build a branch protection rule node; every unmigrated feature off by default. */
function rule(flags: RuleFlags = {}) {
  return {
    allowsForcePushes: flags.allowsForcePushes ?? false,
    requiresDeployments: flags.requiresDeployments ?? false,
    lockBranch: flags.lockBranch ?? false,
    blocksCreations: flags.blocksCreations ?? false,
    requireLastPushApproval: flags.requireLastPushApproval ?? false,
    bypassForcePushAllowances: { totalCount: flags.bypassForcePush ?? 0 },
    bypassPullRequestAllowances: { totalCount: flags.bypassPullRequest ?? 0 },
  };
}

/** Build the repository query response. */
function repoResult(over: {
  discussions?: number;
  projectsV2?: number;
  environments?: number;
  releases?: number;
  stars?: number;
  watchers?: number;
  ruleTotal?: number;
  rules?: ReturnType<typeof rule>[];
}) {
  return {
    repository: {
      discussions: { totalCount: over.discussions ?? 0 },
      projectsV2: { totalCount: over.projectsV2 ?? 0 },
      environments: { totalCount: over.environments ?? 0 },
      releases: { totalCount: over.releases ?? 0 },
      stargazerCount: over.stars ?? 0,
      watchers: { totalCount: over.watchers ?? 0 },
      branchProtectionRules: {
        totalCount: over.ruleTotal ?? over.rules?.length ?? 0,
        nodes: over.rules ?? [],
      },
    },
  };
}

/** A `gql` double returning one queued response and recording its variables. */
function mockGql(response: unknown) {
  const calls: Array<{ owner: string; name: string; rules: number }> = [];
  const fn = (async (_query: string, vars: Record<string, unknown>) => {
    calls.push({
      owner: vars.owner as string,
      name: vars.name as string,
      rules: vars.rules as number,
    });
    return response;
  }) as unknown as typeof graphql;
  return { fn, calls };
}

describe("augmentRepoSignals", () => {
  test("maps every count signal and preserves the discovered fields", async () => {
    const { fn } = mockGql(
      repoResult({
        discussions: 3,
        projectsV2: 2,
        environments: 4,
        releases: 7,
        stars: 41,
        watchers: 9,
      }),
    );

    const signals = await augmentRepoSignals(fn, discovered({ name: "widget" }));

    // Augmented counts.
    expect(signals.discussionsCount).toBe(3);
    expect(signals.projectsV2Count).toBe(2);
    expect(signals.environmentsCount).toBe(4);
    expect(signals.releasesCount).toBe(7);
    expect(signals.stargazerCount).toBe(41);
    expect(signals.watcherCount).toBe(9);
    // Discovered spine preserved.
    expect(signals.nameWithOwner).toBe("acme/widget");
    expect(signals.diskUsageKb).toBe(1234);
    expect(signals.hasDiscussions).toBe(true);
  });

  test("derives the owner from nameWithOwner and caps the rules page", async () => {
    const { fn, calls } = mockGql(repoResult({}));

    await augmentRepoSignals(fn, discovered({ name: "widget", nameWithOwner: "octo-org/widget" }));

    expect(calls[0]).toEqual({ owner: "octo-org", name: "widget", rules: 100 });
  });

  test("counts only branch protection rules that use an unmigrated feature", async () => {
    const { fn } = mockGql(
      repoResult({
        ruleTotal: 4,
        rules: [
          rule({ allowsForcePushes: true }), // unmigrated
          rule({ bypassPullRequest: 2 }), // unmigrated (bypass actors)
          rule({ requireLastPushApproval: true }), // unmigrated
          rule({}), // only migrated features → not counted
        ],
      }),
    );

    const signals = await augmentRepoSignals(fn, discovered());

    expect(signals.branchProtectionRuleCount).toBe(4);
    expect(signals.branchProtectionRulesUsingUnmigratedFeatures).toBe(3);
  });

  test("treats a rule with no unmigrated features as fully migratable", async () => {
    const { fn } = mockGql(repoResult({ ruleTotal: 1, rules: [rule({})] }));

    const signals = await augmentRepoSignals(fn, discovered());

    expect(signals.branchProtectionRuleCount).toBe(1);
    expect(signals.branchProtectionRulesUsingUnmigratedFeatures).toBe(0);
  });

  test("flags each unmigrated feature individually", async () => {
    const cases = [
      rule({ requiresDeployments: true }),
      rule({ lockBranch: true }),
      rule({ blocksCreations: true }),
      rule({ bypassForcePush: 1 }),
    ];
    for (const r of cases) {
      const { fn } = mockGql(repoResult({ ruleTotal: 1, rules: [r] }));
      const signals = await augmentRepoSignals(fn, discovered());
      expect(signals.branchProtectionRulesUsingUnmigratedFeatures).toBe(1);
    }
  });

  test("throws when the repository is missing or inaccessible", async () => {
    const { fn } = mockGql({ repository: null });

    await expect(augmentRepoSignals(fn, discovered())).rejects.toThrow(
      /not found or not accessible/i,
    );
  });
});
