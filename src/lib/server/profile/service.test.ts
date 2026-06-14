/**
 * Tests for the profile service. The source-client builder and the id generator
 * are faked; the runner runs for real (with fake crawl primitives) against a
 * real in-memory store — so these verify the service wiring: synchronous run
 * creation, background completion, source-auth failure, and detail assembly.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { initStore } from "$lib/server/core/db";
import { DOMAIN_STORES } from "$lib/server/registry";
import type { RepoProfile } from "./analyze";
import { runProfile } from "./runner";
import { getProfileDetail, type ProfileServiceDeps, startOrgProfile } from "./service";
import { createProfileRun, recordRepoProfile } from "./store";
import type { DiscoveredRepo, OrgDiscovery, ProfileRun, RepoSignals } from "./types";

function discovered(name: string): DiscoveredRepo {
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

/**
 * Service deps whose runner uses fake crawl primitives. Captures the run promise
 * so a test can await background completion, and records the gql-build call.
 */
function serviceDeps(
  repos: DiscoveredRepo[],
  augmentOver: Record<string, Partial<RepoSignals>> = {},
) {
  const state: { runPromise?: Promise<ProfileRun>; gqlBuilt: number; lastInput?: unknown } = {
    gqlBuilt: 0,
  };
  const deps: ProfileServiceDeps = {
    buildSourceGql: () => {
      state.gqlBuilt += 1;
      return { gql: {} as never, sourceApiUrl: "https://ghes.example.com/api/v3" };
    },
    run: (gql, input) => {
      state.lastInput = input;
      state.runPromise = runProfile(gql, input, undefined, {
        discover: async (): Promise<OrgDiscovery> => ({
          org: input.org,
          total: repos.length,
          repos,
        }),
        augment: async (_gql, repo) => signalsFor(repo, augmentOver[repo.name] ?? {}),
      });
      return state.runPromise;
    },
    newId: () => "fixed-run-id",
  };
  return { deps, state };
}

beforeEach(() => {
  initStore(":memory:", DOMAIN_STORES);
});

describe("startOrgProfile", () => {
  test("creates the run synchronously and returns it in the running state", () => {
    const { deps, state } = serviceDeps([discovered("a")]);

    const run = startOrgProfile("acme", deps);

    expect(run.id).toBe("fixed-run-id");
    expect(run.org).toBe("acme");
    expect(run.sourceApiUrl).toBe("https://ghes.example.com/api/v3");
    expect(run.state).toBe("running");
    expect(state.gqlBuilt).toBe(1);
    expect(state.lastInput).toEqual({
      id: "fixed-run-id",
      org: "acme",
      sourceApiUrl: "https://ghes.example.com/api/v3",
    });
  });

  test("the background crawl completes and persists results", async () => {
    const { deps, state } = serviceDeps([discovered("a"), discovered("b")], {
      a: { discussionsCount: 2 },
    });

    startOrgProfile("acme", deps);
    await state.runPromise; // let the background crawl finish

    const detail = getProfileDetail("fixed-run-id");
    expect(detail?.run.state).toBe("completed");
    expect(detail?.run.profiledRepos).toBe(2);
    expect(detail?.repos.map((r) => r.nameWithOwner)).toEqual(["acme/a", "acme/b"]);
    expect(detail?.repos[0]?.applyingConsiderations).toContainEqual({
      considerationId: "discussions",
      evidence: "2 discussions",
    });
  });

  test("propagates a source-auth failure (no run created)", () => {
    const deps: ProfileServiceDeps = {
      buildSourceGql: () => {
        throw new Error("No source token provided and no source GitHub App configured");
      },
      run: () => Promise.resolve({} as never),
      newId: () => "x",
    };

    expect(() => startOrgProfile("acme", deps)).toThrow(/no source token/i);
    expect(getProfileDetail("x")).toBeNull();
  });
});

describe("getProfileDetail", () => {
  test("returns the run and its repos", () => {
    createProfileRun({ id: "r", sourceApiUrl: "u", org: "acme" });
    const signals = signalsFor(discovered("widget"));
    const profile: RepoProfile = {
      nameWithOwner: "acme/widget",
      findings: [],
      summary: { applies: 0, blockers: 0, warnings: 0, infos: 0, clear: 0, indeterminate: 0 },
    };
    recordRepoProfile("r", signals, profile);

    const detail = getProfileDetail("r");
    expect(detail?.run.id).toBe("r");
    expect(detail?.repos).toHaveLength(1);
    expect(detail?.repos[0]?.nameWithOwner).toBe("acme/widget");
  });

  test("returns null for an unknown run", () => {
    expect(getProfileDetail("nope")).toBeNull();
  });
});
