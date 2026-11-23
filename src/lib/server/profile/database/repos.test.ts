import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeStore, initStore } from "$lib/server/core/db";
import { analyzeRepo } from "../analysis/repos";
import type { RepoSignals } from "../types";
import {
  findMissingProfileProjectPaths,
  getRunRepoPlanProfiles,
  getRunRepoProfiles,
  getRunRepoProfilesPage,
  iterateRunRepoProfiles,
  recordRepoProfile,
} from "./repos";
import { completeProfileRun, createProfileRun } from "./runs";
import { profileStore } from "./schema";

beforeEach(() => initStore(":memory:", [profileStore]));
afterEach(closeStore);

function signals(name: string, overrides: Partial<RepoSignals> = {}): RepoSignals {
  return {
    name: name.split("/").at(-1) ?? name,
    nameWithOwner: name,
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
    pushedAt: null,
    updatedAt: null,
    commitsCount: 10,
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
    issuesCount: 0,
    pullRequestsCount: 0,
    branchesCount: 1,
    tagsCount: 0,
    releasesCount: 0,
    ...overrides,
  };
}

function createRun(): void {
  createProfileRun({
    id: "run",
    sourceApiUrl: "https://api.github.com",
    org: "acme",
  });
}

describe("profile repository persistence", () => {
  test("exact owner filtering precedes repository pagination, plan limits and rollups", () => {
    createRun();
    for (const name of ["Acme/hidden", "acme/child/other", "acme/visible", "acme/visible-two"]) {
      const signal = signals(name);
      recordRepoProfile("run", signal, analyzeRepo(signal));
    }
    expect(getRunRepoProfilesPage("run", { namespace: "acme", limit: 1, page: 2 })).toMatchObject({
      total: 2,
      totalPages: 2,
      repos: [{ nameWithOwner: "acme/visible-two" }],
    });
    expect(getRunRepoPlanProfiles("run", 1, "acme")).toMatchObject([
      { nameWithOwner: "acme/visible" },
    ]);
    expect([...iterateRunRepoProfiles("run", "acme")].map((repo) => repo.nameWithOwner)).toEqual([
      "acme/visible",
      "acme/visible-two",
    ]);
  });
  test("upserts repositories idempotently and reads them in stable order", () => {
    createRun();
    const beta = signals("acme/beta");
    const alpha = signals("acme/alpha");
    recordRepoProfile("run", beta, analyzeRepo(beta));
    recordRepoProfile("run", alpha, analyzeRepo(alpha));
    const updated = signals("acme/alpha", { hasDiscussions: true, discussionsCount: 3 });
    recordRepoProfile("run", updated, analyzeRepo(updated));

    expect(getRunRepoProfiles("run").map(({ nameWithOwner }) => nameWithOwner)).toEqual([
      "acme/alpha",
      "acme/beta",
    ]);
    expect([...iterateRunRepoProfiles("run")].map(({ nameWithOwner }) => nameWithOwner)).toEqual([
      "acme/alpha",
      "acme/beta",
    ]);
    expect(getRunRepoProfiles("run")[0]?.warnings).toBeGreaterThan(0);
  });

  test("supports bounded filtered pages and migration-plan projections", () => {
    createRun();
    const warning = signals("acme/warning", { hasDiscussions: true, discussionsCount: 1 });
    const ready = signals("acme/ready");
    recordRepoProfile("run", warning, analyzeRepo(warning));
    recordRepoProfile("run", ready, analyzeRepo(ready));

    const page = getRunRepoProfilesPage("run", { readiness: "warnings", limit: 500 });
    expect(page).toMatchObject({ page: 1, totalPages: 1, total: 1, limit: 100 });
    expect(page.repos[0]?.nameWithOwner).toBe("acme/warning");
    expect(getRunRepoPlanProfiles("run", 1)).toHaveLength(1);
  });

  test("reports unique missing paths and rejects writes after completion", () => {
    createRun();
    const repo = signals("acme/present");
    recordRepoProfile("run", repo, analyzeRepo(repo));
    expect(
      findMissingProfileProjectPaths("run", ["acme/present", "acme/missing", "acme/missing"]),
    ).toEqual(["acme/missing"]);

    completeProfileRun("run");
    expect(() => recordRepoProfile("run", repo, analyzeRepo(repo))).toThrow(
      "Repositories can only be saved to a running run",
    );
  });
});
