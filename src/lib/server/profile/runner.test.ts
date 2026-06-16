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
import { type ProfileClients, type ProfileRunnerDeps, runProfile } from "./runner";
import { getProfileRun, getRunRepoProfiles } from "./store";
import {
  type DiscoveredRepo,
  type OrgDiscovery,
  type OrgResources,
  type ProfileProgress,
  type RepoSignals,
  ZERO_ORG_RESOURCES,
} from "./types";

// The fakes ignore gql/rest; getApiCalls is called by the runner at completion.
const clients = { getApiCalls: () => 0 } as unknown as ProfileClients;

/** Pass-3 REST stubs for inline deps that reach the per-repo REST pass but don't
 *  care about commits / webhooks / code scanning. Keeps tests off the
 *  real network functions (which would hit the fake `rest` client). */
const noCommits: ProfileRunnerDeps["countCommits"] = async () => 0;
const noRestSignals: ProfileRunnerDeps["gatherRestSignals"] = async () => ({
  webhooksCount: 0,
  hasCodeScanningAlerts: false,
  collaboratorsCount: 0,
  tagProtectionCount: 0,
});

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
    hasPages: false,
    defaultBranch: "main",
    pushedAt: null,
    updatedAt: null,
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
    webhooksCount: 0,
    hasPages: false,
    hasCodeScanningAlerts: false,
    collaboratorsCount: 0,
    tagProtectionCount: 0,
    issuesCount: 0,
    pullRequestsCount: 0,
    branchesCount: 0,
    tagsCount: 0,
    releasesCount: 0,
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
    countCommits: async (_rest, r) => augmentOver[r.name]?.commitsCount ?? 0,
    gatherRestSignals: async (_rest, r) => ({
      webhooksCount: augmentOver[r.name]?.webhooksCount ?? 0,
      hasCodeScanningAlerts: augmentOver[r.name]?.hasCodeScanningAlerts ?? false,
      collaboratorsCount: augmentOver[r.name]?.collaboratorsCount ?? 0,
      tagProtectionCount: augmentOver[r.name]?.tagProtectionCount ?? 0,
    }),
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
      clients,
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
      clients,
      { id: "run-rs", org: "acme", sourceApiUrl: "u" },
      undefined,
      deps([discovered("alpha")], {}, 3),
    );
    expect(run.orgRulesetCount).toBe(3);
  });

  test("records the org resource counts on the run", async () => {
    const run = await runProfile(
      clients,
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
      countCommits: noCommits,
      gatherRestSignals: noRestSignals,
      getOrgRulesetCount: async () => 0,
      getOrgResources: async () => ZERO_ORG_RESOURCES,
    };

    await runProfile(
      clients,
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
      clients,
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
      clients,
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
      clients,
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
      clients,
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
      countCommits: noCommits,
      gatherRestSignals: noRestSignals,
    };

    const run = await runProfile(
      clients,
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
      discovered(`r${String(i).padStart(2, "0")}`),
    );
    const chunkedDeps: Partial<ProfileRunnerDeps> = {
      discover: async () => ({ org: "acme", total: repos.length, repos }),
      augmentCounts: async (_gql, chunk) => {
        if (chunk.some((r) => r.name === "r25")) throw new Error("a chunk failed");
        return chunk.map((r) => countsSignals(r));
      },
      countCommits: noCommits,
      gatherRestSignals: noRestSignals,
    };

    const run = await runProfile(
      clients,
      { id: "r", org: "acme", sourceApiUrl: "u" },
      undefined,
      chunkedDeps,
    );

    expect(run.state).toBe("completed");
    expect(getRunRepoProfiles("r")).toHaveLength(26); // all repos listed despite the failed chunk
  });

  test("batches release-free repos wide (no scan) and release-bearing repos narrow", async () => {
    // The details pass partitions by releases — which come from the counts pass:
    // 2 release-free repos share one lite chunk (scanReleases: false); the 3 with
    // releases share one full chunk (scanReleases: true).
    const repos = [
      discovered("a"),
      discovered("b"),
      discovered("c"),
      discovered("d"),
      discovered("e"),
    ];
    const releasesByName: Record<string, number> = { a: 0, b: 2, c: 0, d: 5, e: 1 };
    const calls: Array<{ size: number; scanReleases: boolean | undefined }> = [];
    const recordingDeps: Partial<ProfileRunnerDeps> = {
      discover: async () => ({ org: "acme", total: repos.length, repos }),
      augmentCounts: async (_gql, c) =>
        c.map((r) => countsSignals(r, { releasesCount: releasesByName[r.name] ?? 0 })),
      augmentDetails: async (_gql, c, opts) => {
        calls.push({ size: c.length, scanReleases: opts?.scanReleases });
        return c.map((r) => detailsFor(r));
      },
      countCommits: noCommits,
      gatherRestSignals: noRestSignals,
    };

    const run = await runProfile(
      clients,
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

  test("merges per-repo commit counts (REST pass) onto the recorded signals", async () => {
    const repos = [discovered("a"), discovered("b")];
    const commitCalls: string[] = [];
    const commitDeps: Partial<ProfileRunnerDeps> = {
      discover: async () => ({ org: "acme", total: repos.length, repos }),
      augmentCounts: async (_gql, c) => c.map((r) => countsSignals(r)),
      augmentDetails: async (_gql, c) => c.map((r) => detailsFor(r)),
      countCommits: async (_rest, r) => {
        commitCalls.push(r.nameWithOwner);
        return r.name === "a" ? 1200 : 42;
      },
      gatherRestSignals: noRestSignals,
    };

    const run = await runProfile(
      clients,
      { id: "r", org: "acme", sourceApiUrl: "u" },
      undefined,
      commitDeps,
    );

    expect(run.state).toBe("completed");
    expect(commitCalls.sort()).toEqual(["acme/a", "acme/b"]); // one call per repo
    const byName = new Map(getRunRepoProfiles("r").map((p) => [p.nameWithOwner, p.signals]));
    expect(byName.get("acme/a")?.commitsCount).toBe(1200);
    expect(byName.get("acme/b")?.commitsCount).toBe(42);
  });

  test("keeps the run completed when a repo's commit count fails", async () => {
    const repos = [discovered("ok"), discovered("boom")];
    const commitDeps: Partial<ProfileRunnerDeps> = {
      discover: async () => ({ org: "acme", total: repos.length, repos }),
      augmentCounts: async (_gql, c) => c.map((r) => countsSignals(r)),
      augmentDetails: async (_gql, c) => c.map((r) => detailsFor(r)),
      countCommits: async (_rest, r) => {
        if (r.name === "boom") throw new Error("commit count blew up");
        return 7;
      },
      gatherRestSignals: noRestSignals,
    };

    const run = await runProfile(
      clients,
      { id: "r", org: "acme", sourceApiUrl: "u" },
      undefined,
      commitDeps,
    );

    // A commit-count failure is best-effort: the run still completes and both
    // repos are listed; the failing repo just keeps commitsCount 0.
    expect(run.state).toBe("completed");
    const byName = new Map(getRunRepoProfiles("r").map((p) => [p.nameWithOwner, p.signals]));
    expect(byName.get("acme/ok")?.commitsCount).toBe(7);
    expect(byName.get("acme/boom")?.commitsCount).toBe(0);
  });

  test("persists the run before crawling (a created run exists by completion)", async () => {
    await runProfile(
      clients,
      { id: "persisted", org: "acme", sourceApiUrl: "u" },
      undefined,
      deps([discovered("a")]),
    );
    expect(getProfileRun("persisted")).not.toBeNull();
  });
});
