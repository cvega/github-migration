/**
 * Tests for the profile runner. The crawl primitives (discover, augment) are
 * injected as fakes, while the store (in-memory) and analyzeRepo run for real —
 * so these verify the orchestration: run lifecycle, the org total, per-repo
 * persistence, progress, and failure handling, with no network.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { initStore } from "$lib/server/store";
import { type ProfileRunnerDeps, runProfile } from "./runner";
import { getProfileRun, getRunRepoProfiles } from "./store";
import type { DiscoveredRepo, OrgDiscovery, ProfileProgress, RepoSignals } from "./types";

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
    ...over,
  };
}

function signalsFor(repo: DiscoveredRepo, over: Partial<RepoSignals> = {}): RepoSignals {
  return {
    ...repo,
    discussionsCount: 0,
    projectsV2Count: 0,
    environmentsCount: 0,
    releasesCount: 0,
    stargazerCount: 0,
    watcherCount: 0,
    branchProtectionRuleCount: 0,
    branchProtectionRulesUsingUnmigratedFeatures: 0,
    ...over,
  };
}

/** Deps whose discover returns the given repos and augment maps each by name. */
function deps(
  repos: DiscoveredRepo[],
  augmentOver: Record<string, Partial<RepoSignals>> = {},
): ProfileRunnerDeps {
  return {
    discover: async (): Promise<OrgDiscovery> => ({ org: "acme", total: repos.length, repos }),
    augment: async (_gql, repo) => signalsFor(repo, augmentOver[repo.name] ?? {}),
  };
}

beforeEach(() => {
  initStore(":memory:");
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

  test("emits progress once per repo with running totals", async () => {
    const repos = [discovered("a"), discovered("b"), discovered("c")];
    const progress: ProfileProgress[] = [];

    await runProfile(
      gql,
      { id: "r", org: "acme", sourceApiUrl: "u" },
      (p) => progress.push(p),
      deps(repos),
    );

    expect(progress).toEqual([
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
    const failingDeps: ProfileRunnerDeps = {
      discover: async () => {
        throw new Error("Organization 'acme' not found or not accessible");
      },
      augment: async (_gql, repo) => signalsFor(repo),
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

  test("marks the run failed if a repo augmentation throws mid-crawl", async () => {
    const repos = [discovered("ok"), discovered("boom")];
    const partialDeps: ProfileRunnerDeps = {
      discover: async () => ({ org: "acme", total: repos.length, repos }),
      augment: async (_gql, repo) => {
        if (repo.name === "boom") throw new Error("repo augmentation failed");
        return signalsFor(repo);
      },
    };

    const run = await runProfile(
      gql,
      { id: "r", org: "acme", sourceApiUrl: "u" },
      undefined,
      partialDeps,
    );

    expect(run.state).toBe("failed");
    expect(run.failureReason).toBe("repo augmentation failed");
    // The repo profiled before the failure was still persisted.
    expect(getRunRepoProfiles("r").map((p) => p.nameWithOwner)).toEqual(["acme/ok"]);
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
