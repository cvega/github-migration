import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { closeStore, getDb, initStore } from "$lib/server/core/db";
import { analyzeRepo } from "$lib/server/profile/analysis/repos";
import { recordRepoProfile } from "../database/repos";
import { startRepositoryAnalysis } from "../database/repository-analysis-runs";
import { completeProfileRun, createProfileRun } from "../database/runs";
import { profileStore } from "../database/schema";
import type { RepoSignals } from "../types";
import {
  processNextRepositoryAnalysisJob,
  type RepositoryAnalysisLoopDependencies,
  runRepositoryAnalysisClaimLoop,
} from "./claim-loop";

beforeEach(() => initStore(":memory:", [profileStore]));
afterEach(closeStore);

function queuedAnalysis(): void {
  createProfileRun({ id: "profile", sourceApiUrl: "https://api.github.com", org: "acme" });
  const signals: RepoSignals = {
    name: "widget",
    nameWithOwner: "acme/widget",
    visibility: "PRIVATE",
    isArchived: false,
    isFork: false,
    isEmpty: false,
    diskUsageKb: 1,
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
  recordRepoProfile("profile", signals, analyzeRepo(signals));
  completeProfileRun("profile");
  let id = 0;
  startRepositoryAnalysis("profile", { newId: () => `id-${id++}`, nowMs: () => 0 });
}

const analysisResult = {
  sourceRefFingerprint: "sha256:refs",
  mirrorSizeBytes: 10,
  gitVersion: "git 2.49.1",
  gitLfsVersion: "git-lfs/3.6.0",
  gitSizerVersion: "git-sizer 1.5.0",
  metrics: {},
  lfsPointers: [],
};

function dependencies(
  analyze: RepositoryAnalysisLoopDependencies["analyze"] = async () => analysisResult,
): RepositoryAnalysisLoopDependencies {
  return {
    analyze,
    getSourceToken: async () => "token",
    newId: () => "result",
  };
}

describe("repository analysis claim loop", () => {
  test("persists analyzer output", async () => {
    queuedAnalysis();
    const processed = await processNextRepositoryAnalysisJob(
      { workspaceRoot: "/analysis", leaseOwner: "worker" },
      dependencies(),
    );
    expect(processed).toBe(true);
    expect(getDb().query("SELECT state FROM profile_repository_analysis_runs").get()).toEqual({
      state: "completed",
    });
  });

  test("persists analyzer failures without crashing the loop", async () => {
    queuedAnalysis();
    const processed = await processNextRepositoryAnalysisJob(
      { workspaceRoot: "/analysis", leaseOwner: "worker" },
      {
        analyze: async () => {
          throw new Error("clone failed");
        },
        getSourceToken: async () => "token",
        newId: () => "unused",
      },
    );
    expect(processed).toBe(true);
    expect(
      getDb().query("SELECT state, failure_reason FROM profile_repository_analysis_jobs").get(),
    ).toEqual({
      state: "failed",
      failure_reason: "clone failed",
    });
  });

  test("returns false when no repository analysis job is queued", async () => {
    expect(
      await processNextRepositoryAnalysisJob(
        { workspaceRoot: "/analysis", leaseOwner: "worker" },
        dependencies(),
      ),
    ).toBe(false);
  });

  test("stops the claim loop after its signal aborts during a completed job", async () => {
    queuedAnalysis();
    const controller = new AbortController();
    let receivedOptions: { workspaceRoot: string; operationalCeilingBytes?: number } | undefined;
    await runRepositoryAnalysisClaimLoop(
      {
        workspaceRoot: "/analysis",
        leaseOwner: "worker",
        operationalCeilingBytes: 1_000,
        signal: controller.signal,
      },
      dependencies(async (_job, options) => {
        receivedOptions = options;
        controller.abort();
        return analysisResult;
      }),
    );

    expect(receivedOptions).toEqual({
      workspaceRoot: "/analysis",
      operationalCeilingBytes: 1_000,
    });
    expect(getDb().query("SELECT state FROM profile_repository_analysis_runs").get()).toEqual({
      state: "completed",
    });
  });

  test("survives losing its lease while recording an analyzer failure", async () => {
    using warning = spyOn(console, "warn").mockImplementation(() => {});
    using error = spyOn(console, "error").mockImplementation(() => {});
    queuedAnalysis();
    const processed = await processNextRepositoryAnalysisJob(
      { workspaceRoot: "/analysis", leaseOwner: "worker" },
      dependencies(async (job) => {
        getDb()
          .prepare("UPDATE profile_repository_analysis_jobs SET lease_owner = ? WHERE id = ?")
          .run("replacement-worker", job.id);
        throw new Error("clone failed");
      }),
    );

    expect(processed).toBe(true);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(
      getDb().query("SELECT state, lease_owner FROM profile_repository_analysis_jobs").get(),
    ).toEqual({ state: "running", lease_owner: "replacement-worker" });
  });
});
