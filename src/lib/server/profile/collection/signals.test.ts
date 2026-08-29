import { describe, expect, test } from "bun:test";
import {
  augmentRepoCounts,
  augmentRepoDetails,
  baseSignals,
  gatherRepoRestSignals,
} from "./signals";

const repo = (name = "one") =>
  ({ name, nameWithOwner: `acme/${name}`, isEmpty: false, defaultBranch: "main" }) as never;

describe("profile signals", () => {
  test("creates a zeroed signal spine and maps GraphQL counts", async () => {
    expect(baseSignals(repo()).issuesCount).toBe(0);
    const gql = async () => ({
      r0: {
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
        rulesets: null,
        branchProtectionRules: { totalCount: 13 },
      },
    });
    const [result] = await augmentRepoCounts(gql as never, [repo()]);
    expect(result).toMatchObject({
      issuesCount: 1,
      pullRequestsCount: 2,
      packagesCount: 12,
      rulesetCount: 0,
      branchProtectionRuleCount: 13,
    });
  });

  test("splits timed-out batches and degrades a timed-out singleton", async () => {
    let calls = 0;
    const gql = async (_query: string, variables: Record<string, unknown>) => {
      calls += 1;
      if ("o1" in variables || variables.n0 === "bad")
        throw Object.assign(new Error("executing your query"), { status: 502 });
      return { r0: null };
    };
    const results = await augmentRepoCounts(gql as never, [repo("good"), repo("bad")]);
    expect(results.map((value) => value.name)).toEqual(["good", "bad"]);
    expect(calls).toBe(3);
  });

  test("maps detail evidence and can omit release scanning", async () => {
    let query = "";
    const gql = async (value: string) => {
      query = value;
      return {
        r0: {
          gitattributes: { text: "*.bin filter=lfs" },
          workflows: { entries: [{ name: "ci.yml" }, { name: "README" }] },
          releases: { nodes: [{ releaseAssets: { nodes: [{ size: 7 }, { size: 5 }] } }] },
          branchProtectionRules: {
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

  test("collects REST signals while isolating endpoint failures", async () => {
    const rest = {
      request: async (route: string) => {
        if (route.includes("hooks"))
          return { data: [{}], headers: { link: '<x?page=2>; rel="last"' } };
        if (route.includes("code-scanning")) throw new Error("forbidden");
        if (route.includes("collaborators")) return { data: [{}], headers: {} };
        return { data: [{}, {}, {}] };
      },
    } as never;
    expect(await gatherRepoRestSignals(rest, repo())).toEqual({
      webhooksCount: 2,
      hasCodeScanningAlerts: false,
      collaboratorsCount: 1,
      tagProtectionCount: 3,
    });
  });
});
