import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { closeStore, initStore } from "$lib/server/core/db";
import { getRunRepoProfiles } from "./database/repos";
import { profileStore } from "./database/schema";
import { type ProfileRunnerDeps, runProfile } from "./runner";
import { ZERO_ORG_RESOURCES } from "./types";

beforeEach(() => initStore(":memory:", [profileStore]));
afterEach(closeStore);

const discovered = {
  name: "repo",
  nameWithOwner: "acme/repo",
  visibility: "PRIVATE",
  isArchived: false,
  isFork: false,
  isEmpty: false,
  diskUsageKb: 10,
  hasWiki: false,
  hasIssues: true,
  hasProjects: false,
  hasDiscussions: false,
  hasPages: false,
  defaultBranch: "main",
  pushedAt: null,
  updatedAt: null,
} as const;
const clients = { rest: {}, gql: async () => ({}), getApiCalls: () => 9 } as never;
const dependencies: ProfileRunnerDeps = {
  discover: async (_rest, org, progress) => {
    progress?.({ org, discovered: 1, total: 1, page: 1 });
    return { org, total: 1, repos: [discovered] };
  },
  augmentCounts: async (_gql, repos) =>
    repos.map((repo) => ({
      ...repo,
      commitsCount: 0,
      discussionsCount: 0,
      projectsV2Count: 0,
      environmentsCount: 0,
      releaseAssetBytes: 0,
      stargazerCount: 0,
      watcherCount: 0,
      forkCount: 0,
      rulesetCount: 0,
      branchProtectionRuleCount: 0,
      branchProtectionRulesUsingUnmigratedFeatures: 0,
      packagesCount: 0,
      usesLfs: false,
      workflowFileCount: 0,
      webhooksCount: 0,
      hasCodeScanningAlerts: false,
      collaboratorsCount: 0,
      tagProtectionCount: 0,
      issuesCount: 4,
      pullRequestsCount: 2,
      branchesCount: 1,
      tagsCount: 0,
      releasesCount: 0,
    })),
  augmentDetails: async (_gql, repos) =>
    repos.map((repo) => ({
      nameWithOwner: repo.nameWithOwner,
      branchProtectionRulesUsingUnmigratedFeatures: 0,
      usesLfs: true,
      workflowFileCount: 1,
      releaseAssetBytes: 0,
    })),
  countCommits: async () => 12,
  gatherRestSignals: async () => ({
    webhooksCount: 2,
    hasCodeScanningAlerts: false,
    collaboratorsCount: 0,
    tagProtectionCount: 0,
  }),
  getOrgRulesetCount: async () => 3,
  getOrgResources: async () => ZERO_ORG_RESOURCES,
};

describe("profile runner", () => {
  test("persists all phases and completes the run", async () => {
    const phases: string[] = [];
    const run = await runProfile(
      clients,
      { id: "run", org: "acme", sourceApiUrl: "https://api.github.com" },
      (value) => phases.push(value.phase),
      dependencies,
    );
    expect(run).toMatchObject({
      state: "completed",
      totalRepos: 1,
      profiledRepos: 1,
      orgRulesetCount: 3,
      apiCalls: 9,
    });
    expect(getRunRepoProfiles("run")[0]?.signals).toMatchObject({
      issuesCount: 4,
      commitsCount: 12,
      usesLfs: true,
      webhooksCount: 2,
    });
    expect(phases).toEqual(
      expect.arrayContaining(["discovering", "organization", "counting", "details", "signals"]),
    );
  });

  test("returns a durable failed run when discovery fails", async () => {
    const run = await runProfile(
      clients,
      { id: "failed", org: "acme", sourceApiUrl: "https://api.github.com" },
      undefined,
      {
        ...dependencies,
        discover: async () => {
          throw Object.assign(new Error("upstream timeout"), { status: 504 });
        },
      },
    );
    expect(run).toMatchObject({ state: "failed", failureReason: "HTTP 504: upstream timeout" });
  });

  test.each([
    {
      phase: "counts",
      dependency: "augmentCounts",
      expected: { issuesCount: 0, usesLfs: true, commitsCount: 12 },
    },
    {
      phase: "details",
      dependency: "augmentDetails",
      expected: { issuesCount: 4, usesLfs: false, commitsCount: 12 },
    },
    {
      phase: "REST signals",
      dependency: "gatherRestSignals",
      expected: { issuesCount: 4, usesLfs: true, commitsCount: 0 },
    },
  ] as const)(
    "retains collected evidence when $phase fails",
    async ({ phase, dependency, expected }) => {
      const failure = new Error(`${phase} unavailable`);
      const log = spyOn(console, "error").mockImplementation(() => {});
      try {
        const run = await runProfile(
          clients,
          { id: "partial", org: "acme", sourceApiUrl: "https://api.github.com" },
          undefined,
          {
            ...dependencies,
            [dependency]: async () => {
              throw failure;
            },
          },
        );

        expect(run.state).toBe("completed");
        expect(getRunRepoProfiles(run.id)[0]?.signals).toMatchObject(expected);
        expect(log).toHaveBeenCalledWith(expect.stringContaining(`${phase} failed`), failure);
      } finally {
        log.mockRestore();
      }
    },
  );

  test.each([
    {
      error: { status: 403, errors: [{ message: "Organization access denied" }] },
      reason: "HTTP 403: Organization access denied",
    },
    { error: { errors: [{ type: "RATE_LIMITED" }] }, reason: "RATE_LIMITED" },
    { error: { status: 502 }, reason: "HTTP 502" },
    { error: "Source connection closed", reason: "Source connection closed" },
  ])("persists an actionable provider failure: $reason", async ({ error, reason }) => {
    const run = await runProfile(
      clients,
      { id: "provider-failed", org: "acme", sourceApiUrl: "https://api.github.com" },
      undefined,
      {
        ...dependencies,
        discover: async () => {
          throw error;
        },
      },
    );
    expect(run).toMatchObject({ state: "failed", failureReason: reason });
    expect(getRunRepoProfiles(run.id)).toEqual([]);
  });

  test("records cancellation before discovery without making provider requests", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Cancelled by operator"));
    const discover = mock(dependencies.discover);
    const run = await runProfile(
      clients,
      {
        id: "cancelled",
        org: "acme",
        sourceApiUrl: "https://api.github.com",
        signal: controller.signal,
      },
      undefined,
      { ...dependencies, discover },
    );

    expect(discover).not.toHaveBeenCalled();
    expect(run).toMatchObject({ state: "failed", failureReason: "Cancelled by operator" });
  });

  test.each(["counting", "details", "signals"] as const)(
    "does not complete a profile cancelled during %s",
    async (phase) => {
      const controller = new AbortController();
      const run = await runProfile(
        clients,
        {
          id: "interrupted",
          org: "acme",
          sourceApiUrl: "https://api.github.com",
          signal: controller.signal,
        },
        (progress) => {
          if (progress.phase === phase) controller.abort("operator request");
        },
        dependencies,
      );

      expect(run).toMatchObject({ state: "failed", failureReason: "Profile worker cancelled" });
      expect(getRunRepoProfiles(run.id)).toHaveLength(1);
      expect(run.completedAt).not.toBeNull();
    },
  );

  test("prioritizes larger repositories and scans release assets only where needed", async () => {
    const countOrder: string[] = [];
    const detailRequests: Array<{ repos: string[]; scanReleases: boolean | undefined }> = [];
    const run = await runProfile(
      clients,
      { id: "prioritized", org: "acme", sourceApiUrl: "https://api.github.com" },
      undefined,
      {
        ...dependencies,
        discover: async () => ({
          org: "acme",
          total: 2,
          repos: [
            discovered,
            { ...discovered, name: "large", nameWithOwner: "acme/large", diskUsageKb: 4096 },
          ],
        }),
        augmentCounts: async (...args) => {
          const values = await dependencies.augmentCounts(...args);
          countOrder.push(...values.map((value) => value.nameWithOwner));
          return values.map((value) => ({
            ...value,
            releasesCount: value.name === "large" ? 1 : 0,
          }));
        },
        augmentDetails: async (gql, repos, options) => {
          detailRequests.push({
            repos: repos.map((repo) => repo.nameWithOwner),
            scanReleases: options?.scanReleases,
          });
          return dependencies.augmentDetails(gql, repos, options);
        },
      },
    );

    expect(run).toMatchObject({ state: "completed", totalRepos: 2, profiledRepos: 2 });
    expect(countOrder).toEqual(["acme/large", "acme/repo"]);
    expect(detailRequests).toEqual([
      { repos: ["acme/repo"], scanReleases: false },
      { repos: ["acme/large"], scanReleases: true },
    ]);
  });
});
