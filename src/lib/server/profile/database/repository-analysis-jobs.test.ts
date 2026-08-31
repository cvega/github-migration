import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeStore, getDb, initStore } from "$lib/server/core/db";
import { analyzeRepo } from "$lib/server/profile/analysis/repos";
import type { RepoSignals } from "../types";
import { recordRepoProfile } from "./repos";
import {
  claimRepositoryAnalysisJob,
  completeRepositoryAnalysisJob,
  failRepositoryAnalysisJob,
  retryRepositoryAnalysisJob,
} from "./repository-analysis-jobs";
import {
  cancelRepositoryAnalysis,
  getRepositoryAnalysisDetail,
  startRepositoryAnalysis,
} from "./repository-analysis-runs";
import { completeProfileRun, createProfileRun } from "./runs";
import { profileStore } from "./schema";

beforeEach(() => initStore(":memory:", [profileStore]));
afterEach(closeStore);

function repo(name: string): RepoSignals {
  return {
    name,
    nameWithOwner: `acme/${name}`,
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
    commitsCount: 1,
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
  };
}

function queuedRun(repoNames: string[]): void {
  createProfileRun({ id: "profile", sourceApiUrl: "https://api.github.com", org: "acme" });
  for (const name of repoNames) {
    const signals = repo(name);
    recordRepoProfile("profile", signals, analyzeRepo(signals));
  }
  completeProfileRun("profile");
  let id = 0;
  startRepositoryAnalysis("profile", {
    newId: () => `id-${id++}`,
    nowMs: () => Date.parse("2026-08-30T00:00:00.000Z"),
  });
}

describe("repository analysis jobs", () => {
  test("claims one job and recovers an expired lease", () => {
    queuedRun(["one"]);
    const first = claimRepositoryAnalysisJob({ leaseOwner: "worker-a", nowMs: 100, leaseMs: 50 });
    expect(first).toMatchObject({ nameWithOwner: "acme/one", attempt: 1 });
    expect(claimRepositoryAnalysisJob({ leaseOwner: "worker-b", nowMs: 120 })).toBeNull();
    const recovered = claimRepositoryAnalysisJob({ leaseOwner: "worker-b", nowMs: 151 });
    expect(recovered).toMatchObject({ id: first?.id, attempt: 2 });
  });

  test("persists normalized results and completes a successful run", () => {
    queuedRun(["one"]);
    const job = claimRepositoryAnalysisJob({ leaseOwner: "worker" });
    if (!job) throw new Error("Expected a job");
    completeRepositoryAnalysisJob({
      job,
      leaseOwner: "worker",
      resultId: "result",
      result: {
        sourceRefFingerprint: "sha256:refs",
        mirrorSizeBytes: 42,
        gitVersion: "git 2.43.0",
        gitLfsVersion: "git-lfs/3.4.1",
        gitSizerVersion: "git-sizer 1.5.0",
        metrics: {
          maxBlobSize: {
            description: "The size of the largest blob object",
            value: 120_000_000,
            unit: "B",
            prefixes: "binary",
            referenceValue: 10_000_000,
            levelOfConcern: 12,
            objectName: "abc",
            objectDescription: "refs/heads/main:video.bin",
          },
        },
        lfsPointers: [{ oid: "sha256:abc", declaredSizeBytes: 10, representativePath: "a.bin" }],
      },
    });
    expect(
      getDb()
        .query("SELECT state, completed_repo_count FROM profile_repository_analysis_runs")
        .get(),
    ).toEqual({
      state: "completed",
      completed_repo_count: 1,
    });
    expect(getDb().query("SELECT oid FROM profile_repository_analysis_lfs_pointers").get()).toEqual(
      {
        oid: "sha256:abc",
      },
    );
    expect(getRepositoryAnalysisDetail("profile")?.jobs[0]?.result).toEqual({
      capturedAt: expect.any(String),
      mirrorSizeBytes: 42,
      lfsPointerCount: 1,
      lfsDeclaredBytes: 10,
      gitSizerMetrics: [
        {
          metric: "maxBlobSize",
          description: "The size of the largest blob object",
          value: 120_000_000,
          unit: "B",
          prefixes: "binary",
          referenceValue: 10_000_000,
          levelOfConcern: 12,
          objectName: "abc",
          objectDescription: "refs/heads/main:video.bin",
        },
      ],
      gitSizerFindings: [
        {
          metric: "maxBlobSize",
          description: "The size of the largest blob object",
          value: 120_000_000,
          unit: "B",
          prefixes: "binary",
          referenceValue: 10_000_000,
          levelOfConcern: 12,
          severity: "warning",
          objectName: "abc",
          objectDescription: "refs/heads/main:video.bin",
        },
      ],
    });
  });

  test("retains a repository failure and completes the run", () => {
    queuedRun(["one"]);
    const job = claimRepositoryAnalysisJob({ leaseOwner: "worker" });
    if (!job) throw new Error("Expected a job");
    failRepositoryAnalysisJob({ job, leaseOwner: "worker", reason: "clone failed" });
    expect(
      getDb().query("SELECT state, failed_repo_count FROM profile_repository_analysis_runs").get(),
    ).toEqual({
      state: "completed",
      failed_repo_count: 1,
    });
  });

  test("requeues only a failed repository and preserves successful siblings", () => {
    queuedRun(["one", "two"]);
    const failed = claimRepositoryAnalysisJob({ leaseOwner: "worker" });
    if (!failed) throw new Error("Expected the first job");
    failRepositoryAnalysisJob({ job: failed, leaseOwner: "worker", reason: "clone failed" });
    const succeeded = claimRepositoryAnalysisJob({ leaseOwner: "worker" });
    if (!succeeded) throw new Error("Expected the second job");
    completeRepositoryAnalysisJob({
      job: succeeded,
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

    retryRepositoryAnalysisJob({
      profileRunId: "profile",
      analysisRunId: failed.analysisRunId,
      jobId: failed.id,
    });

    const detail = getRepositoryAnalysisDetail("profile");
    expect(detail?.run).toMatchObject({
      state: "queued",
      completedRepoCount: 1,
      failedRepoCount: 0,
      completedAt: null,
    });
    expect(detail?.jobs.map(({ id, state, attempt }) => ({ id, state, attempt }))).toEqual([
      { id: failed.id, state: "queued", attempt: 1 },
      { id: succeeded.id, state: "succeeded", attempt: 1 },
    ]);
    expect(claimRepositoryAnalysisJob({ leaseOwner: "retry-worker" })).toMatchObject({
      id: failed.id,
      attempt: 2,
    });
    expect(() =>
      retryRepositoryAnalysisJob({
        profileRunId: "profile",
        analysisRunId: succeeded.analysisRunId,
        jobId: succeeded.id,
      }),
    ).toThrow("Only a failed or cancelled repository analysis job can be retried");
  });

  test("requeues a cancelled repository", () => {
    queuedRun(["one"]);
    const detail = getRepositoryAnalysisDetail("profile");
    if (!detail) throw new Error("Expected an analysis run");
    const job = detail.jobs[0];
    if (!job) throw new Error("Expected an analysis job");
    cancelRepositoryAnalysis("profile", detail.run.id);

    retryRepositoryAnalysisJob({
      profileRunId: "profile",
      analysisRunId: detail.run.id,
      jobId: job.id,
    });

    expect(getRepositoryAnalysisDetail("profile")).toMatchObject({
      run: { state: "queued", failedRepoCount: 0, completedAt: null },
      jobs: [{ state: "queued", failureReason: null }],
    });
  });
});
