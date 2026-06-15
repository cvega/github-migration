/**
 * Tests for the profile runner. The crawl primitives (discover, augment) are
 * injected as fakes, while the store (in-memory) and analyzeRepo run for real —
 * so these verify the orchestration: run lifecycle, the org total, per-repo
 * persistence, progress, and failure handling, with no network.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { initStore } from "$lib/server/core/db";
import { DOMAIN_STORES } from "$lib/server/registry";
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
    releasesCount: 0,
    stargazerCount: 0,
    watcherCount: 0,
    branchProtectionRuleCount: 0,
    branchProtectionRulesUsingUnmigratedFeatures: 0,
    packagesCount: 0,
    usesLfs: false,
    releaseAssetBytes: 0,
    workflowFileCount: 0,
    ...over,
  };
}

/** Deps whose discover returns the given repos and augment maps each chunk by name. */
function deps(
  repos: DiscoveredRepo[],
  augmentOver: Record<string, Partial<RepoSignals>> = {},
  rulesetCount = 0,
  orgResources: Partial<OrgResources> = {},
): ProfileRunnerDeps {
  return {
    discover: async (): Promise<OrgDiscovery> => ({ org: "acme", total: repos.length, repos }),
    augment: async (_gql, chunk) => chunk.map((r) => signalsFor(r, augmentOver[r.name] ?? {})),
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
    const failingDeps: Partial<ProfileRunnerDeps> = {
      discover: async () => {
        throw new Error("Organization 'acme' not found or not accessible");
      },
      augment: async (_gql, chunk) => chunk.map((r) => signalsFor(r)),
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

  test("marks the run failed when a chunk's augmentation throws", async () => {
    const repos = [discovered("ok"), discovered("boom")];
    const partialDeps: Partial<ProfileRunnerDeps> = {
      discover: async () => ({ org: "acme", total: repos.length, repos }),
      augment: async (_gql, chunk) => {
        if (chunk.some((r) => r.name === "boom")) throw new Error("repo augmentation failed");
        return chunk.map((r) => signalsFor(r));
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
  });

  test("persists completed chunks when a later chunk fails", async () => {
    // 26 repos → two augment chunks (25 + 1). The first chunk succeeds and is
    // persisted; the second throws, failing the run — the first chunk survives.
    const repos = Array.from({ length: 26 }, (_, i) =>
      discovered(`r${String(i).padStart(2, "0")}`),
    );
    let call = 0;
    const chunkedDeps: Partial<ProfileRunnerDeps> = {
      discover: async () => ({ org: "acme", total: repos.length, repos }),
      augment: async (_gql, chunk) => {
        call += 1;
        if (call >= 2) throw new Error("second chunk failed");
        return chunk.map((r) => signalsFor(r));
      },
    };

    const run = await runProfile(
      gql,
      { id: "r", org: "acme", sourceApiUrl: "u" },
      undefined,
      chunkedDeps,
    );

    expect(run.state).toBe("failed");
    expect(getRunRepoProfiles("r")).toHaveLength(25); // the first chunk persisted
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
