/**
 * Tests for per-repo GraphQL signal augmentation, split into the cheap counts
 * pass (`augmentRepoCounts`) and the expensive verification pass
 * (`augmentRepoDetails`). The `gql` client is injected, so these exercise query
 * shaping, field mapping, the branch-protection derivation, and the shared
 * resilience (split-on-timeout, degrade, partial-data) without a network.
 */
import { describe, expect, test } from "bun:test";
import type { graphql } from "@octokit/graphql";
import { augmentRepoCounts, augmentRepoDetails } from "./augment";
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
    hasPages: false,
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

/** Build one repository alias node for the cheap counts pass. */
function countsNode(over: {
  issues?: number;
  pullRequests?: number;
  branches?: number;
  tags?: number;
  releases?: number;
  discussions?: number;
  projectsV2?: number;
  environments?: number;
  stars?: number;
  watchers?: number;
  forks?: number;
  packages?: number;
  /** Repo ruleset count, or `null` for a null (no-access) connection. */
  rulesets?: number | null;
  ruleTotal?: number;
}) {
  return {
    issues: { totalCount: over.issues ?? 0 },
    pullRequests: { totalCount: over.pullRequests ?? 0 },
    branches: { totalCount: over.branches ?? 0 },
    tags: { totalCount: over.tags ?? 0 },
    releases: { totalCount: over.releases ?? 0 },
    discussions: { totalCount: over.discussions ?? 0 },
    projectsV2: { totalCount: over.projectsV2 ?? 0 },
    environments: { totalCount: over.environments ?? 0 },
    stargazerCount: over.stars ?? 0,
    forkCount: over.forks ?? 0,
    watchers: { totalCount: over.watchers ?? 0 },
    packages: { totalCount: over.packages ?? 0 },
    rulesets: over.rulesets === null ? null : { totalCount: over.rulesets ?? 0 },
    branchProtectionRules: { totalCount: over.ruleTotal ?? 0 },
  };
}

/** Build one repository alias node for the verification details pass. */
function detailsNode(over: {
  /** Raw `.gitattributes` text; omit for no file (null blob). */
  lfsAttributes?: string;
  /** Workflow file names under `.github/workflows`; omit for no dir (null tree). */
  workflowFiles?: string[];
  /** Asset byte sizes; placed in a single scanned release node (omit = not scanned). */
  releaseAssetSizes?: number[];
  rules?: ReturnType<typeof rule>[];
}) {
  return {
    gitattributes: over.lfsAttributes === undefined ? null : { text: over.lfsAttributes },
    workflows: over.workflowFiles
      ? { entries: over.workflowFiles.map((name) => ({ name })) }
      : null,
    // `releases` is present only on a scanned node (mirrors scanReleases: true).
    ...(over.releaseAssetSizes
      ? {
          releases: {
            nodes: [{ releaseAssets: { nodes: over.releaseAssetSizes.map((size) => ({ size })) } }],
          },
        }
      : {}),
    branchProtectionRules: { nodes: over.rules ?? [] },
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

describe("augmentRepoCounts", () => {
  test("maps every cheap count and preserves the discovered fields", async () => {
    const { fn } = mockGql({
      r0: countsNode({
        issues: 11,
        releases: 7,
        discussions: 3,
        projectsV2: 2,
        environments: 4,
        stars: 41,
        watchers: 9,
        forks: 12,
        packages: 6,
        rulesets: 4,
        ruleTotal: 5,
      }),
    });

    const [s] = await augmentRepoCounts(fn, [discovered()]);

    expect(s?.discussionsCount).toBe(3);
    expect(s?.projectsV2Count).toBe(2);
    expect(s?.environmentsCount).toBe(4);
    expect(s?.stargazerCount).toBe(41);
    expect(s?.watcherCount).toBe(9);
    expect(s?.forkCount).toBe(12);
    expect(s?.packagesCount).toBe(6);
    expect(s?.rulesetCount).toBe(4);
    expect(s?.branchProtectionRuleCount).toBe(5);
    // Discovered spine preserved.
    expect(s?.nameWithOwner).toBe("acme/widget");
    expect(s?.diskUsageKb).toBe(1234);
    expect(s?.issuesCount).toBe(11);
    expect(s?.releasesCount).toBe(7);
    // Verification fields are left at defaults for the details pass.
    expect(s?.commitsCount).toBe(0);
    expect(s?.usesLfs).toBe(false);
    expect(s?.workflowFileCount).toBe(0);
    expect(s?.releaseAssetBytes).toBe(0);
    expect(s?.branchProtectionRulesUsingUnmigratedFeatures).toBe(0);
  });

  test("treats a null rulesets connection as zero (schema allows null)", async () => {
    const { fn } = mockGql({ r0: countsNode({ rulesets: null }) });
    const [s] = await augmentRepoCounts(fn, [discovered()]);
    expect(s?.rulesetCount).toBe(0);
  });

  test("does not pass a $rules variable (counts query has no rule detail)", async () => {
    const { fn, calls } = mockGql({ r0: countsNode({}) });
    await augmentRepoCounts(fn, [discovered({ nameWithOwner: "o/a", name: "a" })]);
    expect(calls[0]).toMatchObject({ o0: "o", n0: "a" });
    expect(calls[0]).not.toHaveProperty("rules");
  });

  test("profiles a whole chunk in one request, in input order", async () => {
    const { fn, calls } = mockGql({
      r0: countsNode({ discussions: 1 }),
      r1: countsNode({ discussions: 2 }),
      r2: countsNode({ discussions: 3 }),
    });

    const signals = await augmentRepoCounts(fn, [
      discovered({ nameWithOwner: "o/a", name: "a" }),
      discovered({ nameWithOwner: "o/b", name: "b" }),
      discovered({ nameWithOwner: "o/c", name: "c" }),
    ]);

    expect(calls).toHaveLength(1);
    expect(signals.map((s) => [s.nameWithOwner, s.discussionsCount])).toEqual([
      ["o/a", 1],
      ["o/b", 2],
      ["o/c", 3],
    ]);
  });

  test("returns no signals for an empty chunk without calling gql", async () => {
    const { fn, calls } = mockGql({});
    const signals = await augmentRepoCounts(fn, []);
    expect(signals).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test("degrades a null alias to zeroed counts (keeps the discovery spine)", async () => {
    const { fn } = mockGql({ r0: countsNode({ discussions: 5 }), r1: null });
    const signals = await augmentRepoCounts(fn, [
      discovered({ nameWithOwner: "o/ok", name: "ok" }),
      discovered({ nameWithOwner: "o/gone", name: "gone", diskUsageKb: 42 }),
    ]);
    expect(signals[0]?.discussionsCount).toBe(5);
    expect(signals[1]?.nameWithOwner).toBe("o/gone");
    expect(signals[1]?.diskUsageKb).toBe(42); // discovery spine kept
    expect(signals[1]?.issuesCount).toBe(0); // augment count zeroed
    expect(signals[1]?.discussionsCount).toBe(0); // augment zeroed
  });

  test("recovers partial data when the request errors with a data payload", async () => {
    const err = Object.assign(new Error("Could not resolve to a Repository"), {
      data: { r0: countsNode({ discussions: 8 }), r1: null },
    });
    const fn = (async () => {
      throw err;
    }) as unknown as typeof graphql;

    const signals = await augmentRepoCounts(fn, [
      discovered({ nameWithOwner: "o/a", name: "a" }),
      discovered({ nameWithOwner: "o/b", name: "b" }),
    ]);
    expect(signals[0]?.discussionsCount).toBe(8);
    expect(signals[1]?.discussionsCount).toBe(0);
  });

  test("rethrows an error with no recoverable data payload", async () => {
    const fn = (async () => {
      throw new Error("network down");
    }) as unknown as typeof graphql;
    await expect(augmentRepoCounts(fn, [discovered()])).rejects.toThrow(/network down/);
  });

  test("splits a timed-out chunk and retries the smaller halves", async () => {
    // 502s for any request wider than 2 repos; succeeds otherwise.
    const sizes: number[] = [];
    const fn = (async (_q: string, vars: Record<string, unknown>) => {
      const size = Object.keys(vars).filter((k) => /^o\d+$/.test(k)).length;
      sizes.push(size);
      if (size > 2) throw Object.assign(new Error("Bad Gateway"), { status: 502 });
      const res: Record<string, unknown> = {};
      for (let i = 0; i < size; i++) res[`r${i}`] = countsNode({});
      return res;
    }) as unknown as typeof graphql;

    const repos = ["a", "b", "c", "d"].map((n) => discovered({ name: n, nameWithOwner: `o/${n}` }));
    const signals = await augmentRepoCounts(fn, repos);
    expect(signals.map((s) => s.nameWithOwner)).toEqual(["o/a", "o/b", "o/c", "o/d"]);
    expect(sizes).toEqual([4, 2, 2]); // 4 timed out → 2 + 2
  });

  test("degrades a single repo that keeps timing out to zeroed counts", async () => {
    const fn = (async () => {
      throw Object.assign(new Error("Gateway Timeout"), { status: 504 });
    }) as unknown as typeof graphql;
    const repos = [
      discovered({ name: "a", nameWithOwner: "o/a", diskUsageKb: 7 }),
      discovered({ name: "b", nameWithOwner: "o/b" }),
    ];
    const signals = await augmentRepoCounts(fn, repos);
    expect(signals).toHaveLength(2);
    expect(signals[0]?.nameWithOwner).toBe("o/a");
    expect(signals[0]?.diskUsageKb).toBe(7); // discovery spine kept
    expect(signals[0]?.issuesCount).toBe(0); // degraded count
    expect(signals[0]?.discussionsCount).toBe(0); // degraded
  });
});

describe("augmentRepoDetails", () => {
  test("detects Git LFS from a .gitattributes with a filter=lfs entry", async () => {
    const { fn } = mockGql({
      r0: detailsNode({ lfsAttributes: "*.psd filter=lfs diff=lfs merge=lfs -text\n" }),
    });
    const [d] = await augmentRepoDetails(fn, [discovered()]);
    expect(d?.usesLfs).toBe(true);
  });

  test("a .gitattributes without filter=lfs is not flagged, and an absent one is false", async () => {
    const a = mockGql({ r0: detailsNode({ lfsAttributes: "*.txt text eol=lf\n" }) });
    expect((await augmentRepoDetails(a.fn, [discovered()]))[0]?.usesLfs).toBe(false);
    const b = mockGql({ r0: detailsNode({}) });
    expect((await augmentRepoDetails(b.fn, [discovered()]))[0]?.usesLfs).toBe(false);
  });

  test("counts only .yml/.yaml workflow files under .github/workflows", async () => {
    const { fn } = mockGql({
      r0: detailsNode({ workflowFiles: ["ci.yml", "release.yaml", "README.md", "dependabot.yml"] }),
    });
    const [d] = await augmentRepoDetails(fn, [discovered()]);
    expect(d?.workflowFileCount).toBe(3);
  });

  test("sums release asset bytes when scanning, passing $rules", async () => {
    const { fn, calls } = mockGql({ r0: detailsNode({ releaseAssetSizes: [1000, 2500, 500] }) });
    const [d] = await augmentRepoDetails(fn, [discovered()], { scanReleases: true });
    expect(d?.releaseAssetBytes).toBe(4000);
    expect(calls[0]).toMatchObject({ rules: 50 });
  });

  test("omits the release-asset scan from the query when scanReleases is false", async () => {
    let query = "";
    const fn = (async (q: string) => {
      query = q;
      return { r0: detailsNode({}) };
    }) as unknown as typeof graphql;
    await augmentRepoDetails(fn, [discovered()], { scanReleases: false });
    expect(query).not.toContain("releaseAssets");
  });

  test("includes the release-asset scan when scanReleases is true", async () => {
    let query = "";
    const fn = (async (q: string) => {
      query = q;
      return { r0: detailsNode({ releaseAssetSizes: [10] }) };
    }) as unknown as typeof graphql;
    await augmentRepoDetails(fn, [discovered()], { scanReleases: true });
    expect(query).toContain("releaseAssets");
  });

  test("counts only branch protection rules that use an unmigrated feature", async () => {
    const { fn } = mockGql({
      r0: detailsNode({
        rules: [
          rule({ allowsForcePushes: true }), // unmigrated
          rule({ bypassPullRequest: 2 }), // unmigrated (bypass actors)
          rule({ requireLastPushApproval: true }), // unmigrated
          rule({}), // only migrated features → not counted
        ],
      }),
    });
    const [d] = await augmentRepoDetails(fn, [discovered()]);
    expect(d?.branchProtectionRulesUsingUnmigratedFeatures).toBe(3);
  });

  test("flags each unmigrated feature individually", async () => {
    const cases = [
      rule({ requiresDeployments: true }),
      rule({ lockBranch: true }),
      rule({ blocksCreations: true }),
      rule({ bypassForcePush: 1 }),
    ];
    for (const r of cases) {
      const { fn } = mockGql({ r0: detailsNode({ rules: [r] }) });
      const [d] = await augmentRepoDetails(fn, [discovered()]);
      expect(d?.branchProtectionRulesUsingUnmigratedFeatures).toBe(1);
    }
  });

  test("degrades a null alias to zeroed details (keeps the repo)", async () => {
    const { fn } = mockGql({
      r0: detailsNode({ workflowFiles: ["ci.yml"] }),
      r1: null,
    });
    const details = await augmentRepoDetails(fn, [
      discovered({ nameWithOwner: "o/ok", name: "ok" }),
      discovered({ nameWithOwner: "o/gone", name: "gone" }),
    ]);
    expect(details[0]?.workflowFileCount).toBe(1);
    expect(details[1]?.nameWithOwner).toBe("o/gone");
    expect(details[1]?.workflowFileCount).toBe(0);
  });

  test("treats a timeout message (not just a status) as splittable", async () => {
    let calls = 0;
    const fn = (async (_q: string, vars: Record<string, unknown>) => {
      const size = Object.keys(vars).filter((k) => /^o\d+$/.test(k)).length;
      calls += 1;
      if (size > 1) throw new Error("Something went wrong while executing your query");
      return { r0: detailsNode({ workflowFiles: ["ci.yml"] }) };
    }) as unknown as typeof graphql;

    const repos = [
      discovered({ name: "a", nameWithOwner: "o/a" }),
      discovered({ name: "b", nameWithOwner: "o/b" }),
    ];
    const details = await augmentRepoDetails(fn, repos);
    expect(details.map((d) => d.workflowFileCount)).toEqual([1, 1]);
    expect(details.map((d) => d.nameWithOwner)).toEqual(["o/a", "o/b"]);
    expect(calls).toBe(3); // 2 (timeout) → 1 + 1
  });
});
