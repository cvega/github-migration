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
    issuesCount: 0,
    pullRequestsCount: 0,
    branchesCount: 0,
    tagsCount: 0,
    releasesCount: 0,
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

/** Build one repository alias node. */
function node(over: {
  commits?: number;
  discussions?: number;
  projectsV2?: number;
  environments?: number;
  stars?: number;
  watchers?: number;
  packages?: number;
  /** Raw `.gitattributes` text; omit for no file (null blob). */
  lfsAttributes?: string;
  /** Workflow file names under `.github/workflows`; omit for no dir (null tree). */
  workflowFiles?: string[];
  /** Asset byte sizes; placed in a single scanned release node (omit = not scanned). */
  releaseAssetSizes?: number[];
  ruleTotal?: number;
  rules?: ReturnType<typeof rule>[];
  noDefaultBranch?: boolean;
}) {
  return {
    defaultBranchRef: over.noDefaultBranch
      ? null
      : { target: { history: { totalCount: over.commits ?? 0 } } },
    discussions: { totalCount: over.discussions ?? 0 },
    projectsV2: { totalCount: over.projectsV2 ?? 0 },
    environments: { totalCount: over.environments ?? 0 },
    // `releases` is present only on a scanned node (mirrors scanReleases: true).
    ...(over.releaseAssetSizes
      ? {
          releases: {
            nodes: [{ releaseAssets: { nodes: over.releaseAssetSizes.map((size) => ({ size })) } }],
          },
        }
      : {}),
    stargazerCount: over.stars ?? 0,
    watchers: { totalCount: over.watchers ?? 0 },
    packages: { totalCount: over.packages ?? 0 },
    gitattributes: over.lfsAttributes === undefined ? null : { text: over.lfsAttributes },
    workflows: over.workflowFiles
      ? { entries: over.workflowFiles.map((name) => ({ name })) }
      : null,
    branchProtectionRules: {
      totalCount: over.ruleTotal ?? over.rules?.length ?? 0,
      nodes: over.rules ?? [],
    },
  };
}

/**
 * A `gql` double returning a queued aliased response (keyed `r0`, `r1`, …) and
 * recording the variables it was called with.
 */
function mockGql(response: Record<string, unknown>) {
  const calls: Array<Record<string, unknown>> = [];
  const fn = (async (_query: string, vars: Record<string, unknown>) => {
    calls.push(vars);
    return response;
  }) as unknown as typeof graphql;
  return { fn, calls };
}

describe("augmentRepoSignals", () => {
  test("maps every count signal and preserves the discovered fields", async () => {
    const { fn } = mockGql({
      r0: node({
        commits: 512,
        discussions: 3,
        projectsV2: 2,
        environments: 4,
        stars: 41,
        watchers: 9,
      }),
    });

    const [signals] = await augmentRepoSignals(fn, [
      discovered({ issuesCount: 11, releasesCount: 7 }),
    ]);

    // Augmented counts.
    expect(signals?.commitsCount).toBe(512);
    expect(signals?.discussionsCount).toBe(3);
    expect(signals?.projectsV2Count).toBe(2);
    expect(signals?.environmentsCount).toBe(4);
    expect(signals?.stargazerCount).toBe(41);
    expect(signals?.watcherCount).toBe(9);
    // Discovered spine preserved (incl. the content counts from discovery).
    expect(signals?.nameWithOwner).toBe("acme/widget");
    expect(signals?.diskUsageKb).toBe(1234);
    expect(signals?.issuesCount).toBe(11);
    expect(signals?.releasesCount).toBe(7);
  });

  test("maps the packages count", async () => {
    const { fn } = mockGql({ r0: node({ packages: 6 }) });
    const [signals] = await augmentRepoSignals(fn, [discovered()]);
    expect(signals?.packagesCount).toBe(6);
  });

  test("detects Git LFS from a .gitattributes with a filter=lfs entry", async () => {
    const { fn } = mockGql({
      r0: node({ lfsAttributes: "*.psd filter=lfs diff=lfs merge=lfs -text\n" }),
    });
    const [signals] = await augmentRepoSignals(fn, [discovered()]);
    expect(signals?.usesLfs).toBe(true);
  });

  test("a .gitattributes without filter=lfs is not flagged as LFS", async () => {
    const { fn } = mockGql({ r0: node({ lfsAttributes: "*.txt text eol=lf\n" }) });
    const [signals] = await augmentRepoSignals(fn, [discovered()]);
    expect(signals?.usesLfs).toBe(false);
  });

  test("an absent .gitattributes means no LFS", async () => {
    const { fn } = mockGql({ r0: node({}) });
    const [signals] = await augmentRepoSignals(fn, [discovered()]);
    expect(signals?.usesLfs).toBe(false);
    expect(signals?.packagesCount).toBe(0);
  });

  test("sums release asset bytes across releases", async () => {
    const { fn } = mockGql({ r0: node({ releaseAssetSizes: [1000, 2500, 500] }) });
    const [signals] = await augmentRepoSignals(fn, [discovered()]);
    expect(signals?.releaseAssetBytes).toBe(4000);
  });

  test("a repo with no releases has zero release asset bytes", async () => {
    const { fn } = mockGql({ r0: node({}) });
    const [signals] = await augmentRepoSignals(fn, [discovered()]);
    expect(signals?.releaseAssetBytes).toBe(0);
  });

  test("omits the release-asset scan from the query when scanReleases is false", async () => {
    let query = "";
    const fn = (async (q: string) => {
      query = q;
      return { r0: node({}) };
    }) as unknown as typeof graphql;

    await augmentRepoSignals(fn, [discovered()], { scanReleases: false });
    expect(query).not.toContain("releaseAssets");
  });

  test("includes the release-asset scan from the query when scanReleases is true", async () => {
    let query = "";
    const fn = (async (q: string) => {
      query = q;
      return { r0: node({ releaseAssetSizes: [10] }) };
    }) as unknown as typeof graphql;

    await augmentRepoSignals(fn, [discovered()], { scanReleases: true });
    expect(query).toContain("releaseAssets");
  });

  test("counts only .yml/.yaml workflow files under .github/workflows", async () => {
    const { fn } = mockGql({
      r0: node({ workflowFiles: ["ci.yml", "release.yaml", "README.md", "dependabot.yml"] }),
    });
    const [signals] = await augmentRepoSignals(fn, [discovered()]);
    expect(signals?.workflowFileCount).toBe(3);
  });

  test("a repo with no .github/workflows tree has zero workflow files", async () => {
    const { fn } = mockGql({ r0: node({}) });
    const [signals] = await augmentRepoSignals(fn, [discovered()]);
    expect(signals?.workflowFileCount).toBe(0);
  });

  test("treats a missing default branch as zero commits", async () => {
    const { fn } = mockGql({ r0: node({ noDefaultBranch: true }) });

    const [signals] = await augmentRepoSignals(fn, [discovered({ isEmpty: true })]);

    expect(signals?.commitsCount).toBe(0);
  });

  test("derives owner/name per alias and caps the rules page", async () => {
    const { fn, calls } = mockGql({ r0: node({}), r1: node({}) });

    await augmentRepoSignals(fn, [
      discovered({ name: "widget", nameWithOwner: "octo-org/widget" }),
      discovered({ name: "gadget", nameWithOwner: "octo-org/gadget" }),
    ]);

    expect(calls[0]).toMatchObject({
      rules: 100,
      o0: "octo-org",
      n0: "widget",
      o1: "octo-org",
      n1: "gadget",
    });
  });

  test("profiles a whole chunk in a single request, in input order", async () => {
    const { fn, calls } = mockGql({
      r0: node({ commits: 1 }),
      r1: node({ commits: 2 }),
      r2: node({ commits: 3 }),
    });

    const signals = await augmentRepoSignals(fn, [
      discovered({ nameWithOwner: "o/a", name: "a" }),
      discovered({ nameWithOwner: "o/b", name: "b" }),
      discovered({ nameWithOwner: "o/c", name: "c" }),
    ]);

    expect(calls).toHaveLength(1); // one batched request for three repos
    expect(signals.map((s) => [s.nameWithOwner, s.commitsCount])).toEqual([
      ["o/a", 1],
      ["o/b", 2],
      ["o/c", 3],
    ]);
  });

  test("counts only branch protection rules that use an unmigrated feature", async () => {
    const { fn } = mockGql({
      r0: node({
        ruleTotal: 4,
        rules: [
          rule({ allowsForcePushes: true }), // unmigrated
          rule({ bypassPullRequest: 2 }), // unmigrated (bypass actors)
          rule({ requireLastPushApproval: true }), // unmigrated
          rule({}), // only migrated features → not counted
        ],
      }),
    });

    const [signals] = await augmentRepoSignals(fn, [discovered()]);

    expect(signals?.branchProtectionRuleCount).toBe(4);
    expect(signals?.branchProtectionRulesUsingUnmigratedFeatures).toBe(3);
  });

  test("treats a rule with no unmigrated features as fully migratable", async () => {
    const { fn } = mockGql({ r0: node({ ruleTotal: 1, rules: [rule({})] }) });

    const [signals] = await augmentRepoSignals(fn, [discovered()]);

    expect(signals?.branchProtectionRuleCount).toBe(1);
    expect(signals?.branchProtectionRulesUsingUnmigratedFeatures).toBe(0);
  });

  test("flags each unmigrated feature individually", async () => {
    const cases = [
      rule({ requiresDeployments: true }),
      rule({ lockBranch: true }),
      rule({ blocksCreations: true }),
      rule({ bypassForcePush: 1 }),
    ];
    for (const r of cases) {
      const { fn } = mockGql({ r0: node({ ruleTotal: 1, rules: [r] }) });
      const [signals] = await augmentRepoSignals(fn, [discovered()]);
      expect(signals?.branchProtectionRulesUsingUnmigratedFeatures).toBe(1);
    }
  });

  test("returns no signals for an empty chunk without calling gql", async () => {
    const { fn, calls } = mockGql({});

    const signals = await augmentRepoSignals(fn, []);

    expect(signals).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test("degrades a null alias to zeroed signals (keeps the discovery spine)", async () => {
    const { fn } = mockGql({ r0: node({ commits: 5 }), r1: null });

    const signals = await augmentRepoSignals(fn, [
      discovered({ nameWithOwner: "o/ok", name: "ok" }),
      discovered({ nameWithOwner: "o/gone", name: "gone", issuesCount: 3 }),
    ]);

    expect(signals[0]?.commitsCount).toBe(5);
    // The inaccessible repo keeps its discovered fields but zeroes augment counts.
    expect(signals[1]?.nameWithOwner).toBe("o/gone");
    expect(signals[1]?.issuesCount).toBe(3);
    expect(signals[1]?.commitsCount).toBe(0);
    expect(signals[1]?.branchProtectionRuleCount).toBe(0);
  });

  test("recovers partial data when the request errors with a data payload", async () => {
    // GraphQL returns partial data + errors when one alias is inaccessible; the
    // client surfaces that as a throw carrying `.data`. Recover the good repos.
    const err = Object.assign(new Error("Could not resolve to a Repository"), {
      data: { r0: node({ commits: 8 }), r1: null },
    });
    const fn = (async () => {
      throw err;
    }) as unknown as typeof graphql;

    const signals = await augmentRepoSignals(fn, [
      discovered({ nameWithOwner: "o/a", name: "a" }),
      discovered({ nameWithOwner: "o/b", name: "b" }),
    ]);

    expect(signals[0]?.commitsCount).toBe(8);
    expect(signals[1]?.commitsCount).toBe(0);
  });

  test("rethrows an error with no recoverable data payload", async () => {
    const fn = (async () => {
      throw new Error("network down");
    }) as unknown as typeof graphql;

    await expect(augmentRepoSignals(fn, [discovered()])).rejects.toThrow(/network down/);
  });
});
