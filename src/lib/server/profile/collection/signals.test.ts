import { describe, expect, test } from "bun:test";
import { augmentRepoCounts, augmentRepoDetails, gatherRepoRestSignals } from "./signals";

const repo = (name = "one") =>
  ({ name, nameWithOwner: `acme/${name}`, isEmpty: false, defaultBranch: "main" }) as never;

describe("profile signals", () => {
  const counts = {
    isEmpty: false,
    issues: { totalCount: 1 },
    pullRequests: { totalCount: 2 },
    branches: { totalCount: 3 },
    tags: { totalCount: 4 },
    releases: { totalCount: 5 },
    discussions: { totalCount: 6 },
    projectsV2: { totalCount: 7 },
    environments: { totalCount: 8 },
    stargazerCount: 9,
    forkCount: 10,
    watchers: { totalCount: 11 },
    packages: { totalCount: 12 },
    rulesets: { totalCount: 0 },
    branchProtectionRules: { totalCount: 13 },
  };
  test("maps measured GraphQL counts", async () => {
    const gql = async () => ({ r0: counts });
    const [result] = await augmentRepoCounts(gql as never, [repo()]);
    expect(result).toMatchObject({
      issuesCount: 1,
      pullRequestsCount: 2,
      packagesCount: 12,
      rulesetCount: 0,
      branchProtectionRuleCount: 13,
    });
  });

  test("splits timed-out batches but rejects a timed-out singleton", async () => {
    let calls = 0;
    const gql = async (_query: string, variables: Record<string, unknown>) => {
      calls += 1;
      if ("o1" in variables || variables.n0 === "bad")
        throw Object.assign(new Error("executing your query"), { status: 502 });
      return { r0: counts };
    };
    await expect(augmentRepoCounts(gql as never, [repo("good"), repo("bad")])).rejects.toThrow(
      "executing your query",
    );
    expect(calls).toBe(3);
  });

  test.each([
    {},
    { r0: null },
    { r0: { ...counts, rulesets: null } },
    { r0: { ...counts, stargazerCount: undefined } },
  ])("rejects incomplete counts", async (data) => {
    await expect(augmentRepoCounts((async () => data) as never, [repo()])).rejects.toThrow(
      "Incomplete GraphQL data for acme/one",
    );
  });

  test("does not salvage partial GraphQL error data", async () => {
    const gql = async () => {
      throw Object.assign(new Error("GraphQL denied"), { data: { r0: counts } });
    };
    await expect(augmentRepoCounts(gql as never, [repo()])).rejects.toThrow("GraphQL denied");
  });

  test("distinguishes an absent Git object from missing detail fields", async () => {
    const r0 = {
      gitattributes: null,
      workflows: null,
      branchProtectionRules: { pageInfo: { hasNextPage: false }, nodes: [] },
    };
    const gql = (async () => ({ r0 })) as never;
    expect(await augmentRepoDetails(gql, [repo()], { scanReleases: false })).toMatchObject([
      { usesLfs: false, workflowFileCount: 0 },
    ]);
    await expect(augmentRepoDetails(gql, [repo()])).rejects.toThrow("releases");
    await expect(
      augmentRepoDetails(
        (async () => ({ r0: { ...r0, workflows: undefined } })) as never,
        [repo()],
        { scanReleases: false },
      ),
    ).rejects.toThrow("workflows");
  });

  test("maps detail evidence and can omit release scanning", async () => {
    let query = "";
    const gql = async (value: string) => {
      query = value;
      return {
        r0: {
          gitattributes: { text: "*.bin filter=lfs" },
          workflows: { entries: [{ name: "ci.yml" }, { name: "README" }] },
          releases: {
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                releaseAssets: {
                  pageInfo: { hasNextPage: false },
                  nodes: [{ size: 7 }, { size: 5 }],
                },
              },
            ],
          },
          branchProtectionRules: {
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                allowsForcePushes: true,
                requiresDeployments: false,
                lockBranch: false,
                blocksCreations: false,
                requireLastPushApproval: false,
                bypassForcePushAllowances: { totalCount: 0 },
                bypassPullRequestAllowances: { totalCount: 0 },
              },
            ],
          },
        },
      };
    };
    const [result] = await augmentRepoDetails(gql as never, [repo()]);
    expect(result).toMatchObject({
      usesLfs: true,
      workflowFileCount: 1,
      releaseAssetBytes: 12,
      branchProtectionRulesUsingUnmigratedFeatures: 1,
    });
    await augmentRepoDetails(gql as never, [repo()], { scanReleases: false });
    expect(query).not.toContain("releases(first:");
  });

  test.each([
    [51, 50, 30],
    [50, 51, 30],
    [50, 50, 31],
    [50, 50, 30],
  ])(
    "records completeness for %i rules, %i releases and %i assets",
    async (rules, releases, assets) => {
      function page<T>(total: number, cap: number, node: T) {
        return {
          nodes: Array(Math.min(total, cap)).fill(node),
          pageInfo: { hasNextPage: total > cap },
        };
      }
      const rule = {
        allowsForcePushes: false,
        requiresDeployments: false,
        lockBranch: false,
        blocksCreations: false,
        requireLastPushApproval: false,
        bypassForcePushAllowances: { totalCount: 0 },
        bypassPullRequestAllowances: { totalCount: 0 },
      };
      const gql = async (query: string) => {
        expect(query.match(/pageInfo \{ hasNextPage \}/g)).toHaveLength(3);
        return {
          r0: {
            workflows: null,
            gitattributes: null,
            branchProtectionRules: page(rules, 50, rule),
            releases: page(releases, 50, { releaseAssets: page(assets, 30, { size: 0 }) }),
          },
        };
      };
      const [detail] = await augmentRepoDetails(gql as never, [repo()]);
      expect(detail).toMatchObject({
        branchRuleScanComplete: rules <= 50,
        releaseAssetScanComplete: releases <= 50 && assets <= 30,
        branchProtectionRulesUsingUnmigratedFeatures: 0,
        releaseAssetBytes: 0,
      });
    },
  );

  test("collects REST signals while isolating endpoint failures", async () => {
    const rest = {
      request: async (route: string) => {
        if (route.includes("hooks"))
          return { data: [{}], headers: { link: '<x?page=2>; rel="last"' } };
        if (route.includes("code-scanning"))
          throw Object.assign(new Error("forbidden"), { status: 403 });
        if (route.includes("collaborators")) return { data: [{}], headers: {} };
        return { data: [{}, {}, {}] };
      },
    } as never;
    expect(await gatherRepoRestSignals(rest, repo())).toEqual({
      webhooksCount: 2,
      hasCodeScanningAlerts: null,
      collaboratorsCount: 1,
      tagProtectionCount: 3,
    });
  });
  test("distinguishes successful empty lists from unreadable lists", async () => {
    for (const data of [[], {}]) {
      const rest = { request: async () => ({ data, headers: {} }) } as never;
      const empty = Array.isArray(data);
      expect(await gatherRepoRestSignals(rest, repo())).toEqual({
        webhooksCount: empty ? 0 : null,
        collaboratorsCount: empty ? 0 : null,
        tagProtectionCount: empty ? 0 : null,
        hasCodeScanningAlerts: empty ? false : null,
      });
    }
  });
});
