import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { repositoryAnalysisAllowsPlanning } from "$lib/profile/repository-analysis";
import { closeStore, getDb, initStore } from "$lib/server/core/db";
import { analyzeRepo } from "$lib/server/profile/analysis/repos";
import { buildProfileDetailRollup } from "../analysis/rollup";
import { getProfileDetail } from "../service";
import type { RepoSignals } from "../types";
import { getRunRepoPlanProfiles, recordRepoProfile } from "./repos";
import {
  claimRepositoryAnalysisJob,
  completeRepositoryAnalysisJob,
} from "./repository-analysis-jobs";
import {
  cancelRepositoryAnalysis,
  findRepositoriesAwaitingAnalysis,
  startRepositoryAnalysis,
} from "./repository-analysis-runs";
import { completeProfileRun, createProfileRun, getProfileRunRollup } from "./runs";
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

function completedProfile(): void {
  createProfileRun({ id: "profile", sourceApiUrl: "https://api.github.com", org: "acme" });
  for (const repo of [
    signals("acme/empty", { isEmpty: true, diskUsageKb: 0 }),
    signals("acme/known", { diskUsageKb: 2 * 1024 ** 2 }),
    signals("acme/unknown", { diskUsageKb: null, usesLfs: true }),
  ]) {
    recordRepoProfile("profile", repo, analyzeRepo(repo));
  }
  completeProfileRun("profile");
}

describe("repository analysis runs", () => {
  test("requires a completed profile", () => {
    createProfileRun({ id: "profile", sourceApiUrl: "https://api.github.com", org: "acme" });
    expect(() => startRepositoryAnalysis("profile")).toThrow(
      "Repository analysis requires a completed profile",
    );
  });

  test("creates one prioritized job per non-empty repository and is idempotent", () => {
    completedProfile();
    let nextId = 0;
    const deps = { newId: () => `id-${nextId++}`, nowMs: () => 1_786_944_000_000 };
    const created = startRepositoryAnalysis("profile", deps);
    const repeated = startRepositoryAnalysis("profile", deps);

    expect(repeated.run.id).toBe(created.run.id);
    expect(created.run).toMatchObject({
      selectedRepoCount: 2,
      unknownSizeRepoCount: 1,
      estimatedCloneBytes: 2 * 1024 ** 3,
      estimatedPeakWorkspaceBytes: 5 * 1024 ** 3,
    });
    expect(created.jobs.map((job) => job.nameWithOwner)).toEqual(["acme/unknown", "acme/known"]);
    expect(created.jobs[0]?.priorityReasons).toEqual([
      "Unknown API size",
      "LFS configuration detected",
    ]);
  });

  test("cancels the run and queued jobs", () => {
    completedProfile();
    const detail = startRepositoryAnalysis("profile");
    cancelRepositoryAnalysis("profile", detail.run.id);
    const next = startRepositoryAnalysis("profile");
    expect(next.run.id).not.toBe(detail.run.id);
  });

  test("requires analysis only for repositories with findings", () => {
    createProfileRun({ id: "profile", sourceApiUrl: "https://api.github.com", org: "acme" });
    const clean = signals("acme/clean");
    const warning = signals("acme/warn", { hasDiscussions: true, discussionsCount: 1 });
    recordRepoProfile("profile", clean, analyzeRepo(clean));
    recordRepoProfile("profile", warning, analyzeRepo(warning));
    completeProfileRun("profile");

    expect(findRepositoriesAwaitingAnalysis("profile", ["acme/clean", "acme/warn"])).toEqual([
      "acme/warn",
    ]);
  });

  test.each([
    { branchRuleScanComplete: false },
    { releaseAssetScanComplete: false },
    { branchProtectionRuleCount: 51 },
    { releasesCount: 1 },
  ])("requires successful analysis for incomplete scans with zero findings", (partial) => {
    createProfileRun({ id: "profile", sourceApiUrl: "https://api.github.com", org: "acme" });
    const repo = signals("acme/partial", partial);
    recordRepoProfile("profile", repo, analyzeRepo(repo));
    completeProfileRun("profile");
    const [planned] = getRunRepoPlanProfiles("profile", 1);
    if (!planned) throw new Error("missing repository");
    expect(planned).toMatchObject({ warnings: 0, blockers: 0 });
    expect(repositoryAnalysisAllowsPlanning(planned, null)).toBe(false);
    expect(findRepositoriesAwaitingAnalysis("profile", [repo.nameWithOwner])).toEqual([
      repo.nameWithOwner,
    ]);
  });

  test("keeps incomplete readiness visible for both empty and nonempty repositories", () => {
    createProfileRun({ id: "profile", sourceApiUrl: "https://api.github.com", org: "acme" });
    const partial = { branchRuleScanComplete: false, releaseAssetScanComplete: false };
    const empty = signals("acme/empty", {
      ...partial,
      isEmpty: true,
      commitsCount: 0,
      defaultBranch: null,
      branchesCount: 0,
    });
    const nonempty = signals("acme/nonempty", partial);
    const clean = signals("acme/clean");
    for (const repo of [empty, nonempty, clean])
      recordRepoProfile("profile", repo, analyzeRepo(repo));
    completeProfileRun("profile");

    const legacy = buildProfileDetailRollup([]);
    const summary: Record<string, unknown> = { ...legacy.summary, cleanRepos: 3 };
    delete summary.incompleteRepos;
    getDb()
      .prepare("UPDATE profile_runs SET detail_rollup = ? WHERE id = ?")
      .run(JSON.stringify({ ...legacy, summary }), "profile");

    const planning = getRunRepoPlanProfiles("profile", 10);
    expect(
      planning
        .filter((repo) => repositoryAnalysisAllowsPlanning(repo, null))
        .map((repo) => repo.nameWithOwner),
    ).toEqual([clean.nameWithOwner, empty.nameWithOwner]);
    expect(
      findRepositoriesAwaitingAnalysis(
        "profile",
        planning.map((repo) => repo.nameWithOwner),
      ),
    ).toEqual([nonempty.nameWithOwner]);
    expect(startRepositoryAnalysis("profile").jobs.map((job) => job.nameWithOwner)).toEqual([
      clean.nameWithOwner,
      nonempty.nameWithOwner,
    ]);
    expect(getProfileDetail("profile")?.summary).toMatchObject({
      cleanRepos: 1,
      incompleteRepos: 2,
    });
    expect(getProfileRunRollup("profile")?.summary).toMatchObject({
      cleanRepos: 1,
      incompleteRepos: 2,
    });
  });

  test.each([{ discussionsCount: 1 }, { releaseAssetScanComplete: false }])(
    "allows a repository after its required analysis succeeds",
    (evidence) => {
      createProfileRun({ id: "profile", sourceApiUrl: "https://api.github.com", org: "acme" });
      const warning = signals("acme/warn", evidence);
      recordRepoProfile("profile", warning, analyzeRepo(warning));
      completeProfileRun("profile");
      startRepositoryAnalysis("profile");
      const job = claimRepositoryAnalysisJob({ leaseOwner: "worker" });
      if (!job) throw new Error("Expected an analysis job");
      completeRepositoryAnalysisJob({
        job,
        leaseOwner: "worker",
        resultId: "result",
        result: {
          sourceRefFingerprint: "sha256:refs",
          mirrorSizeBytes: 42,
          gitVersion: "git 2.49.1",
          gitLfsVersion: "git-lfs/3.6.0",
          gitSizerVersion: "git-sizer 1.5.0",
          metrics: {},
          lfsPointers: [],
        },
      });

      expect(findRepositoriesAwaitingAnalysis("profile", ["acme/warn"])).toEqual([]);
    },
  );
});
