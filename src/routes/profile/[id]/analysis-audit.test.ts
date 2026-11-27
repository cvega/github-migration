import { afterEach, beforeEach, expect, test } from "bun:test";
import { isActionFailure } from "@sveltejs/kit";
import { authStore } from "$lib/server/core/auth/schema";
import { createUser } from "$lib/server/core/auth/users";
import { closeStore, getDb, initStore } from "$lib/server/core/db";
import { analyzeRepo } from "$lib/server/profile/analysis/repos";
import { recordRepoProfile } from "$lib/server/profile/database/repos";
import { completeProfileRun, createProfileRun } from "$lib/server/profile/database/runs";
import { profileStore } from "$lib/server/profile/database/schema";
import type { RepoSignals } from "$lib/server/profile/types";
import { actions } from "./+page.server";

const profileRunId = "profile-id";
const sourceToken = "synthetic-source-token";
const signals: RepoSignals = {
  name: "widget",
  nameWithOwner: "acme/widget",
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
};

beforeEach(() => initStore(":memory:", [authStore, profileStore]));
afterEach(closeStore);

test("records the administrator and IDs for successful analysis actions", async () => {
  const { user } = await createUser({ username: "audit-admin", role: "admin" });
  createProfileRun({
    id: profileRunId,
    sourceApiUrl: "https://github.invalid/api/v3",
    org: "acme",
  });
  recordRepoProfile(profileRunId, signals, analyzeRepo(signals));
  completeProfileRun(profileRunId);

  const url = new URL("https://dashboard.invalid/profile/profile-id");
  async function run(action: keyof typeof actions, data: Record<string, string> = {}) {
    const event = {
      params: { id: profileRunId },
      locals: { authEnabled: true, user },
      request: new Request(url, {
        method: "POST",
        body: new URLSearchParams({ ...data, token: sourceToken }),
      }),
    } as Parameters<(typeof actions)[string]>[0];
    return actions[action]!(event);
  }

  const previousToken = process.env.GH_SOURCE_PAT;
  process.env.GH_SOURCE_PAT = sourceToken;
  try {
    expect(await run("startAnalysis")).toHaveProperty("analysisSuccess");
    const job = getDb()
      .query<{ id: string; analysis_run_id: string }, []>(
        "SELECT id, analysis_run_id FROM profile_repository_analysis_jobs",
      )
      .get()!;
    const analysisRunId = job.analysis_run_id;
    expect(await run("cancelAnalysis", { analysisRunId })).toHaveProperty("analysisSuccess");
    expect(isActionFailure(await run("cancelAnalysis", { analysisRunId }))).toBe(true);
    expect(await run("retryAnalysisJob", { analysisRunId, jobId: job.id })).toHaveProperty(
      "analysisSuccess",
    );

    const events = getDb()
      .query(
        "SELECT actor_user_id, action, resource_type, resource_id, metadata FROM audit_events ORDER BY id",
      )
      .all();
    expect(events).toEqual(
      [
        ["profile.analysis.started", { profileRunId }],
        ["profile.analysis.cancelled", { profileRunId }],
        ["profile.analysis.job.retried", { profileRunId, jobId: job.id }],
      ].map(([action, metadata]) => ({
        actor_user_id: user.id,
        action,
        resource_type: "analysis",
        resource_id: analysisRunId,
        metadata: JSON.stringify(metadata),
      })),
    );
  } finally {
    if (previousToken === undefined) delete process.env.GH_SOURCE_PAT;
    else process.env.GH_SOURCE_PAT = previousToken;
  }
});
