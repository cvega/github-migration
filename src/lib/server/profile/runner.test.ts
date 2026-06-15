/**
 * Tests for the profile runner. The crawl primitives (discover, augment) are
 * injected as fakes, while the store (in-memory) and analyzeRepo run for real —
 * so these verify the orchestration: run lifecycle, the org total, per-repo
 * persistence, progress, and failure handling, with no network.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { initStore } from "$lib/server/core/db";
import { DOMAIN_STORES } from "$lib/server/registry";
import type { RepoDetails } from "./augment";
import { type ProfileRunnerDeps, runProfile } from "./runner";
import { getProfileRun, getRunRepoProfiles } from "./store";
import {
  type DiscoveredRepo,
  type OrgDiscovery,
  type OrgResources,
  type ProfileProgress,
  type RepoSignals,
  ZERO_ORG_RESOURCES,
} from "./types";

const gql = {} as never; // the fakes ignore it

function discovered(name: string, over: Partial<DiscoveredRepo> = {}): DiscoveredRepo {
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
    defaultBranch: "main",
    pushedAt: null,
    updatedAt: null,
    issuesCount: 0,
    pullRequestsCount: 0,
    branchesCount: 0,
    tagsCount: 0,
    releasesCount: 0,
    ...over,
  };
}

function signalsFor(repo: DiscoveredRepo, over: Partial<RepoSignals> = {}): RepoSignals {
  return {
    ...repo,
    commitsCount: 0,
    discussionsCount: 0,
    projectsV2Count: 0,
    environmentsCount: 0,
    stargazerCount: 0,
    watcherCount: 0,
    forkCount: 0,
    rulesetCount: 0,
    branchProtectionRuleCount: 0,
    branchProtectionRulesUsingUnmigratedFeatures: 0,
    packagesCount: 0,
    usesLfs: false,
    releaseAssetBytes: 0,
    workflowFileCount: 0,
    ...over,
  };
}

/** Counts-pass signals (verification fields defaulted, as pass 1 produces). */
function countsSignals(repo: DiscoveredRepo, over: Partial<RepoSignals> = {}): RepoSignals {
  return {
    ...signalsFor(repo, over),
    commitsCount: 0,
    branchProtectionRulesUsingUnmigratedFeatures: 0,
    usesLfs: false,
    workflowFileCount: 0,
    releaseAssetBytes: 0,
  };
}

/** Verification details for a repo (the pass-2 fake), derived from `signalsFor`. */
function detailsFor(repo: DiscoveredRepo, over: Partial<RepoSignals> = {}): RepoDetails {
  const s = signalsFor(repo, over);
  return {
    nameWithOwner: repo.nameWithOwner,
    commitsCount: s.commitsCount,
    branchProtectionRulesUsingUnmigratedFeatures: s.branchProtectionRulesUsingUnmigratedFeatures,
    usesLfs: s.usesLfs,
    workflowFileCount: s.workflowFileCount,
    releaseAssetBytes: s.releaseAssetBytes,
  };
}

/** Deps whose discover returns the given repos and the two passes map by name. */
function deps(
  repos: DiscoveredRepo[],
  augmentOver: Record<string, Partial<RepoSignals>> = {},
  rulesetCount = 0,
  orgResources: Partial<OrgResources> = {},
): ProfileRunnerDeps {
  return {
    discover: async (): Promise<OrgDiscovery> => ({ org: "acme", total: repos.length, repos }),
    augmentCounts: async (_gql, c) => c.map((r) => countsSignals(r, augmentOver[r.name] ?? {})),
    augmentDetails: async (_gql, c) => c.map((r) => detailsFor(r, augmentOver[r.name] ?? {})),
    getOrgRulesetCount: async () => rulesetCount,
    getOrgResources: async () => ({ ...ZERO_ORG_RESOURCES, ...orgResources }),
  };
}

beforeEach(() => {
  initStore(":memory:", DOMAIN_STORES);
});

describe("runProfile", () => {
  test("profiles every repo, records the total, and completes the run", async () => {
    const repos = [discovered("alpha"), discovered("beta", { hasWiki: true })];

    const run = await runProfile(
      gql,
      { id: "run-1", org: "acme", sourceApiUrl: "https://ghes.example.com/api/v3" },
      undefined,
      deps(repos, { alpha: { discussionsCount: 2 } }),
    );

    expect(run.state).toBe("completed");
    expect(run.totalRepos).toBe(2);
    expect(run.profiledRepos).toBe(2);
    // alpha: discussions(warn). beta: wiki(info). So warnings = 1 across the run.
    expect(run.warnings).toBe(1);

    const profiles = getRunRepoProfiles("run-1");
    expect(profiles.map((p) => p.nameWithOwner)).toEqual(["acme/alpha", "acme/beta"]);
    expect(profiles[0]?.applyingConsiderations).toContainEqual({
      considerationId: "discussions",
      evidence: "2 discussions",
    });
  });

  test("records the org ruleset count on the run", async () => {
    const run = await runProfile(
      gql,
      { id: "run-rs", org: "acme", sourceApiUrl: "u" },
      undefined,
      deps([discovered("alpha")], {}, 3),
    );
    expect(run.orgRulesetCount).toBe(3);
  });

  test("records the org resource counts on the run", async () => {
    const run = await runProfile(
      gql,
      { id: "run-or", org: "acme", sourceApiUrl: "u" },
      undefined,
      deps([discovered("alpha")], {}, 0, { actionsSecrets: 5, selfHostedRunners: 2 }),
    );
    expect(run.orgResources.actionsSecrets).toBe(5);
    expect(run.orgResources.selfHostedRunners).toBe(2);
    expect(run.orgResources.codespacesSecrets).toBe(0);
  });

  test("sets the run total from the first discovery page and nudges watchers", async () => {
    const repos = [discovered("a"), discovered("b")];
    const progress: ProfileProgress[] = [];
    const withDiscoveryProgress: Partial<ProfileRunnerDeps> = {
      discover: async (_gql, _org, onProgress) => {
        // The org total is known from page 1, before the repos are returned.
        onProgress?.({ org: "acme", discovered: 2, total: 2, page: 1 });
        return { org: "acme", total: 2, repos };
      },
      augmentCounts: async (_gql, c) => c.map((r) => countsSignals(r)),
      augmentDetails: async (_gql, c) => c.map((r) => detailsFor(r)),
      getOrgRulesetCount: async () => 0,
      getOrgResources: async () => ZERO_ORG_RESOURCES,
    };

    await runProfile(
      gql,
      { id: "disc", org: "acme", sourceApiUrl: "u" },
      (p) => progress.push(p),
      withDiscoveryProgress,
    );

    // The first nudge is the discovery one (profiled 0), before any per-repo
    // progress, and the run total is set from it.
    expect(progress[0]).toEqual({ runId: "disc", profiled: 0, total: 2, repo: "" });
    expect(getProfileRun("disc")?.totalRepos).toBe(2);
  });

  test("records a richer failure reason for an HTTP error (status + message)", async () => {
    const failing: Partial<ProfileRunnerDeps> = {
      discover: async () => {
        throw Object.assign(new Error("Something went wrong while executing your query"), {
          status: 502,
        });
      },
    };

    const run = await runProfile(
      gql,
      { id: "http", org: "acme", sourceApiUrl: "u" },
      undefined,
      failing,
    );

    expect(run.state).toBe("failed");
    expect(run.failureReason).toContain("HTTP 502");
    expect(run.failureReason).toContain("Something went wrong");
  });

  test("emits progress once per repo with running totals", async () => {
    const repos = [discovered("a"), discovered("b"), discovered("c")];
    const progress: ProfileProgress[] = [];

    await runProfile(
      gql,
      { id: "r", org: "acme", sourceApiUrl: "u" },
      (p) => progress.push(p),
      deps(repos),
    );

    // Pass 1 emits one per-repo frame as each repo's counts are recorded. (The
    // details pass adds repo-less nudges, filtered out here.)
    expect(progress.filter((p) => p.repo !== "")).toEqual([
      { runId: "r", profiled: 1, total: 3, repo: "acme/a" },
      { runId: "r", profiled: 2, total: 3, repo: "acme/b" },
      { runId: "r", profiled: 3, total: 3, repo: "acme/c" },
    ]);
  });

  test("completes an empty organization with zero profiled repos", async () => {
    const run = await runProfile(
      gql,
      { id: "r", org: "acme", sourceApiUrl: "u" },
      undefined,
      deps([]),
    );

    expect(run.state).toBe("completed");
    expect(run.totalRepos).toBe(0);
    expect(run.profiledRepos).toBe(0);
  });

  test("marks the run failed (not thrown) when discovery fails", async () => {
    const failingDeps: Partial<ProfileRunnerDeps> = {
      discover: async () => {
        throw new Error("Organization 'acme' not found or not accessible");
      },
    };

    const run = await runProfile(
      gql,
      { id: "r", org: "acme", sourceApiUrl: "u" },
      undefined,
      failingDeps,
    );

    expect(run.state).toBe("failed");
    expect(run.failureReason).toMatch(/not found or not accessible/);
  });

  test("keeps the run completed (repos still listed) when a counts chunk fails", async () => {
    const repos = [discovered("ok"), discovered("boom")];
    const partialDeps: Partial<ProfileRunnerDeps> = {
      discover: async () => ({ org: "acme", total: repos.length, repos }),
      augmentCounts: async (_gql, chunk) => {
        if (chunk.some((r) => r.name === "boom")) throw new Error("repo augmentation failed");
        return chunk.map((r) => countsSignals(r));
      },
    };

    const run = await runProfile(
      gql,
      { id: "r", org: "acme", sourceApiUrl: "u" },
      undefined,
      partialDeps,
    );

    // The counts pass is best-effort: a chunk failure no longer fails the run.
    // Both repos were recorded from discovery, so the list survives.
    expect(run.state).toBe("completed");
    expect(
      getRunRepoProfiles("r")
        .map((p) => p.nameWithOwner)
        .sort(),
    ).toEqual(["acme/boom", "acme/ok"]);
  });

  test("lists every repo even when a counts chunk fails, enriching the rest", async () => {
    // 26 repos at COUNTS_CHUNK=15 → chunks of 15 + 11. The chunk holding r25
    // throws in the counts pass; every repo is still listed (recorded at
    // discovery) and the run completes.
    const repos = Array.from({ length: 26 }, (_, i) =>
      discovered(`r${String(i).padStart(2, "0")}`, { releasesCount: 1 }),
    );
    const chunkedDeps: Partial<ProfileRunnerDeps> = {
      discover: async () => ({ org: "acme", total: repos.length, repos }),
      augmentCounts: async (_gql, chunk) => {
        if (chunk.some((r) => r.name === "r25")) throw new Error("a chunk failed");
        return chunk.map((r) => countsSignals(r));
      },
    };

    const run = await runProfile(
      gql,
      { id: "r", org: "acme", sourceApiUrl: "u" },
      undefined,
      chunkedDeps,
    );

    expect(run.state).toBe("completed");
    expect(getRunRepoProfiles("r")).toHaveLength(26); // all repos listed despite the failed chunk
  });

  test("batches release-free repos wide (no scan) and release-bearing repos narrow", async () => {
    // The details pass partitions by releases: 2 release-free repos share one
    // lite chunk (scanReleases: false); the 3 with releases share one full
    // chunk (scanReleases: true).
    const repos = [
      discovered("a", { releasesCount: 0 }),
      discovered("b", { releasesCount: 2 }),
      discovered("c", { releasesCount: 0 }),
      discovered("d", { releasesCount: 5 }),
      discovered("e", { releasesCount: 1 }),
    ];
    const calls: Array<{ size: number; scanReleases: boolean | undefined }> = [];
    const recordingDeps: Partial<ProfileRunnerDeps> = {
      discover: async () => ({ org: "acme", total: repos.length, repos }),
      augmentCounts: async (_gql, c) => c.map((r) => countsSignals(r)),
      augmentDetails: async (_gql, c, opts) => {
        calls.push({ size: c.length, scanReleases: opts?.scanReleases });
        return c.map((r) => detailsFor(r));
      },
    };

    const run = await runProfile(
      gql,
      { id: "r", org: "acme", sourceApiUrl: "u" },
      undefined,
      recordingDeps,
    );

    expect(run.state).toBe("completed");
    expect(run.profiledRepos).toBe(5);
    const lite = calls.find((c) => c.scanReleases === false);
    const full = calls.find((c) => c.scanReleases === true);
    expect(lite?.size).toBe(2); // release-free repos, batched together
    expect(full?.size).toBe(3); // release-bearing repos, batched together
  });

  test("persists the run before crawling (a created run exists by completion)", async () => {
    await runProfile(
      gql,
      { id: "persisted", org: "acme", sourceApiUrl: "u" },
      undefined,
      deps([discovered("a")]),
    );
    expect(getProfileRun("persisted")).not.toBeNull();
  });
});
