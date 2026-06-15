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
import { type ProfileSseEvent, subscribeProfile } from "./events";
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
    issuesCount: 0,
    pullRequestsCount: 0,
    branchesCount: 0,
    tagsCount: 0,
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
    run: (gql, input, onProgress) => {
      state.lastInput = input;
      state.runPromise = runProfile(gql, input, onProgress, {
        discover: async (): Promise<OrgDiscovery> => ({
          org: input.org,
          total: repos.length,
          repos,
        }),
        augment: async (_gql, chunk) => chunk.map((r) => signalsFor(r, augmentOver[r.name] ?? {})),
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

  test("streams per-repo progress and a terminal done event to subscribers", async () => {
    const { deps, state } = serviceDeps([discovered("a"), discovered("b")]);
    const frames: string[] = [];
    const controller = {
      enqueue: (chunk: string) => {
        frames.push(chunk);
      },
    } as unknown as ReadableStreamDefaultController<string>;

    startOrgProfile("acme", deps);
    // Subscribe synchronously: the background crawl is suspended at its first
    // await, so no events have fired yet.
    const unsubscribe = subscribeProfile("fixed-run-id", controller);
    await state.runPromise; // the done publish is chained before this resolves
    unsubscribe();

    const events = frames.map(
      (f) => JSON.parse(f.replace(/^data: /, "").trimEnd()) as ProfileSseEvent,
    );
    const progress = events.filter((e) => e.type === "progress");
    expect(progress).toEqual([
      { type: "progress", profiled: 1, total: 2, repo: "acme/a" },
      { type: "progress", profiled: 2, total: 2, repo: "acme/b" },
    ]);
    expect(events.at(-1)).toEqual({ type: "done", state: "completed" });
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

  test("attaches derived insights to each repo", () => {
    createProfileRun({ id: "r", sourceApiUrl: "u", org: "acme" });
    const archived = signalsFor(discovered("old"), { isArchived: true });
    const profile: RepoProfile = {
      nameWithOwner: "acme/old",
      findings: [],
      summary: { applies: 0, blockers: 0, warnings: 0, infos: 0, clear: 0, indeterminate: 0 },
    };
    recordRepoProfile("r", archived, profile);

    const detail = getProfileDetail("r");
    expect(detail?.repos[0]?.insights.map((i) => i.id)).toContain("archived-move-now");
  });

  test("derives the org migration-scale rollup by summing repo signals", () => {
    createProfileRun({ id: "r", sourceApiUrl: "u", org: "acme" });
    const emptyProfile = (nameWithOwner: string): RepoProfile => ({
      nameWithOwner,
      findings: [],
      summary: { applies: 0, blockers: 0, warnings: 0, infos: 0, clear: 0, indeterminate: 0 },
    });
    recordRepoProfile(
      "r",
      signalsFor(discovered("a"), {
        issuesCount: 10,
        pullRequestsCount: 4,
        commitsCount: 100,
        branchesCount: 3,
        tagsCount: 2,
        releasesCount: 1,
        diskUsageKb: 500,
      }),
      emptyProfile("acme/a"),
    );
    recordRepoProfile(
      "r",
      signalsFor(discovered("b"), {
        issuesCount: 5,
        pullRequestsCount: 6,
        commitsCount: 50,
        branchesCount: 1,
        tagsCount: 0,
        releasesCount: 2,
        diskUsageKb: 250,
      }),
      emptyProfile("acme/b"),
    );

    const scale = getProfileDetail("r")?.scale;
    expect(scale).toEqual({
      repos: 2,
      issues: 15,
      pullRequests: 10,
      commits: 150,
      branches: 4,
      tags: 2,
      releases: 3,
      diskUsageKb: 750,
    });
  });

  test("returns null for an unknown run", () => {
    expect(getProfileDetail("nope")).toBeNull();
  });
});
