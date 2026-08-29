import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
});
