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
import type { RepoDetails } from "./augment";
import { clearPause, isPauseRequested } from "./control";
import { runEnterpriseProfile } from "./enterprise-runner";
import { type EnterpriseSseEvent, type ProfileSseEvent, subscribeProfile } from "./events";
import { runProfile } from "./runner";
import {
  getProfileDetail,
  type ProfileServiceDeps,
  requestEnterprisePause,
  requestProfilePause,
  resumeEnterpriseRun,
  resumeInterruptedProfiles,
  resumeProfileRun,
  startEnterpriseProfile,
  startOrgProfile,
} from "./service";
import {
  completeEnterpriseRun,
  completeProfileRun,
  createEnterpriseRun,
  createProfileRun,
  getEnrichedRepoNames,
  getEnterpriseChildRuns,
  getEnterpriseRun,
  getProfileRun,
  pauseEnterpriseRun,
  pauseProfileRun,
  recordRepoProfile,
  setRepoEnriched,
} from "./store";
import type { DiscoveredRepo, OrgDiscovery, RepoSignals } from "./types";

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
    hasPages: false,
    defaultBranch: "main",
    pushedAt: null,
    updatedAt: null,
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

/**
 * Service deps whose runner uses fake crawl primitives. Captures the run promise
 * so a test can await background completion, and records the gql-build call.
 */
function serviceDeps(
  repos: DiscoveredRepo[],
  augmentOver: Record<string, Partial<RepoSignals>> = {},
  orgs: string[] = [],
) {
  const state: { runPromise?: Promise<unknown>; gqlBuilt: number; lastInput?: unknown } = {
    gqlBuilt: 0,
  };
  const deps: ProfileServiceDeps = {
    buildSourceClients: () => {
      state.gqlBuilt += 1;
      return {
        gql: {} as never,
        rest: {} as never,
        sourceApiUrl: "https://ghes.example.com/api/v3",
        getApiCalls: () => 0,
      };
    },
    run: (clients, input, onProgress) => {
      state.lastInput = input;
      const runPromise = runProfile(clients, input, onProgress, {
        discover: async (): Promise<OrgDiscovery> => ({
          org: input.org,
          total: repos.length,
          repos,
        }),
        augmentCounts: async (_gql, chunk) =>
          chunk.map((r) => signalsFor(r, augmentOver[r.name] ?? {})),
        augmentDetails: async (_gql, chunk) =>
          chunk.map((r) => detailsFor(r, augmentOver[r.name] ?? {})),
        countCommits: async (_rest, r) => augmentOver[r.name]?.commitsCount ?? 0,
        gatherRestSignals: async (_rest, r) => ({
          webhooksCount: augmentOver[r.name]?.webhooksCount ?? 0,
          hasCodeScanningAlerts: augmentOver[r.name]?.hasCodeScanningAlerts ?? false,
          collaboratorsCount: augmentOver[r.name]?.collaboratorsCount ?? 0,
          tagProtectionCount: augmentOver[r.name]?.tagProtectionCount ?? 0,
        }),
      });
      state.runPromise = runPromise;
      return runPromise;
    },
    runEnterprise: (clients, input, onProgress, edeps) => {
      let n = 0;
      const promise = runEnterpriseProfile(clients, input, onProgress, {
        ...edeps,
        discoverOrgs: async () => ({ orgs, inaccessible: 0 }),
        newId: () => `child-${n++}`,
      });
      state.runPromise = promise;
      return promise;
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
      buildSourceClients: () => {
        throw new Error("No source token provided and no source GitHub App configured");
      },
      run: () => Promise.resolve({} as never),
      runEnterprise: () => Promise.resolve({} as never),
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
    // Per-repo frames come from the counts pass; the details pass adds repo-less
    // refetch nudges, filtered out here.
    const progress = events.filter((e) => e.type === "progress" && e.repo !== "");
    expect(progress).toEqual([
      { type: "progress", profiled: 1, total: 2, repo: "acme/a", phase: "counting" },
      { type: "progress", profiled: 2, total: 2, repo: "acme/b", phase: "counting" },
    ]);
    expect(events.at(-1)).toEqual({ type: "done", state: "completed" });
  });
});

describe("startEnterpriseProfile", () => {
  test("creates the enterprise run synchronously and returns it running", () => {
    const { deps } = serviceDeps([], {}, ["alpha", "beta"]);

    const run = startEnterpriseProfile("acme-inc", deps);

    expect(run.id).toBe("fixed-run-id");
    expect(run.enterpriseSlug).toBe("acme-inc");
    expect(run.sourceApiUrl).toBe("https://ghes.example.com/api/v3");
    expect(run.state).toBe("running");
  });

  test("runs a child org profile per enumerated org and aggregates them", async () => {
    const { deps, state } = serviceDeps([discovered("a"), discovered("b")], {}, ["alpha", "beta"]);

    const run = startEnterpriseProfile("acme-inc", deps);
    await state.runPromise; // let the enterprise crawl finish

    const children = getEnterpriseChildRuns(run.id);
    expect(children.map((c) => c.org)).toEqual(["alpha", "beta"]);
    // Each child is linked to the enterprise and profiled the two repos.
    expect(children.every((c) => c.enterpriseRunId === run.id)).toBe(true);
    expect(children.every((c) => c.state === "completed")).toBe(true);
    expect(children.every((c) => c.totalRepos === 2)).toBe(true);
  });

  test("publishes each child org's own SSE (child detail pages stay live)", async () => {
    const { deps, state } = serviceDeps([discovered("a")], {}, ["alpha"]);

    startEnterpriseProfile("acme-inc", deps);
    // The child run id is deterministic in the test harness ("child-0").
    const frames: string[] = [];
    subscribeProfile("child-0", {
      enqueue: (f: string) => frames.push(f),
    } as unknown as ReadableStreamDefaultController<string>);

    await state.runPromise;

    const events = frames.map(
      (f) => JSON.parse(f.replace(/^data: /, "").trimEnd()) as ProfileSseEvent,
    );
    // The child terminal `done` is published, so its detail page settles.
    expect(events.at(-1)).toEqual({ type: "done", state: "completed" });
  });

  test("publishes enterprise-level SSE (per-org progress + terminal done)", async () => {
    const { deps, state } = serviceDeps([discovered("a")], {}, ["alpha", "beta"]);

    startEnterpriseProfile("acme-inc", deps);
    // Subscribe to the enterprise channel (id is the fixed harness id).
    const frames: string[] = [];
    subscribeProfile("fixed-run-id", {
      enqueue: (f: string) => frames.push(f),
    } as unknown as ReadableStreamDefaultController<string>);

    await state.runPromise;

    const events = frames.map(
      (f) => JSON.parse(f.replace(/^data: /, "").trimEnd()) as EnterpriseSseEvent,
    );
    // One settle nudge per org (rising profiledOrgs), then a terminal done.
    const settles = events.filter((e) => e.type === "progress" && e.org !== "");
    expect(settles.map((e) => (e.type === "progress" ? e.org : "")).sort()).toEqual([
      "alpha",
      "beta",
    ]);
    expect(events.at(-1)).toEqual({ type: "done", state: "completed" });
  });
});

describe("resumeInterruptedProfiles", () => {
  const emptyProfile = (nameWithOwner: string): RepoProfile => ({
    nameWithOwner,
    findings: [],
    summary: { applies: 0, blockers: 0, warnings: 0, infos: 0, clear: 0, indeterminate: 0 },
  });

  test("resumes a standalone running run, reprocessing only unfinished repos", async () => {
    // An interrupted run: two repos recorded, one already enriched.
    createProfileRun({ id: "rz", sourceApiUrl: "u", org: "acme" });
    recordRepoProfile("rz", signalsFor(discovered("a")), emptyProfile("acme/a"));
    recordRepoProfile("rz", signalsFor(discovered("b")), emptyProfile("acme/b"));
    setRepoEnriched("rz", "acme/a");

    const { deps, state } = serviceDeps([discovered("a"), discovered("b")]);
    resumeInterruptedProfiles(deps, () => true);
    await state.runPromise;

    // The unfinished repo is enriched and the run completes.
    expect([...getEnrichedRepoNames("rz")].sort()).toEqual(["acme/a", "acme/b"]);
    expect(getProfileRun("rz")?.state).toBe("completed");
  });

  test("fails interrupted runs when no source credentials are available", () => {
    createProfileRun({ id: "rz", sourceApiUrl: "u", org: "acme" });
    const { deps, state } = serviceDeps([]);

    resumeInterruptedProfiles(deps, () => false);

    expect(getProfileRun("rz")?.state).toBe("failed");
    expect(getProfileRun("rz")?.failureReason).toMatch(/restarted/i);
    // It never built a client when it can't resume.
    expect(state.gqlBuilt).toBe(0);
  });

  test("is a no-op when nothing is running", () => {
    const { deps } = serviceDeps([]);
    expect(() => resumeInterruptedProfiles(deps, () => true)).not.toThrow();
  });

  test("resumes an interrupted enterprise run, skipping finished child orgs", async () => {
    // An interrupted enterprise: org "done" already finished, org "team" pending.
    createEnterpriseRun({ id: "ent", sourceApiUrl: "u", enterpriseSlug: "acme-inc" });
    createProfileRun({ id: "c-done", sourceApiUrl: "u", org: "done", enterpriseRunId: "ent" });
    completeProfileRun("c-done");

    // The fresh enumeration returns both orgs; only "team" still needs profiling.
    const { deps, state } = serviceDeps([discovered("a")], {}, ["done", "team"]);
    resumeInterruptedProfiles(deps, () => true);
    await state.runPromise;

    // The enterprise completes; "done" is untouched, "team" gets a fresh child run.
    expect(getEnterpriseRun("ent")?.state).toBe("completed");
    const children = getEnterpriseChildRuns("ent");
    expect(children.map((c) => c.org).sort()).toEqual(["done", "team"]);
    expect(children.find((c) => c.org === "done")?.id).toBe("c-done"); // not re-run
    expect(state.gqlBuilt).toBeGreaterThan(0); // a source client was built to resume
  });
});

describe("requestProfilePause / resumeProfileRun", () => {
  const emptyProfile = (nameWithOwner: string): RepoProfile => ({
    nameWithOwner,
    findings: [],
    summary: { applies: 0, blockers: 0, warnings: 0, infos: 0, clear: 0, indeterminate: 0 },
  });

  test("requestProfilePause flags a running run for the crawl to observe", () => {
    createProfileRun({ id: "rp", sourceApiUrl: "u", org: "acme" });
    const run = requestProfilePause("rp");
    expect(run?.id).toBe("rp");
    expect(isPauseRequested("rp")).toBe(true);
    clearPause("rp"); // don't leak the request into later tests
  });

  test("requestProfilePause is a no-op for a settled run and null for an unknown one", () => {
    createProfileRun({ id: "done", sourceApiUrl: "u", org: "acme" });
    completeProfileRun("done");
    expect(requestProfilePause("done")?.state).toBe("completed");
    expect(isPauseRequested("done")).toBe(false);
    expect(requestProfilePause("missing")).toBeNull();
  });

  test("resumeProfileRun re-dispatches a paused run to completion", async () => {
    // A paused run with one repo already enriched, one still pending.
    createProfileRun({ id: "rp", sourceApiUrl: "u", org: "acme" });
    recordRepoProfile("rp", signalsFor(discovered("a")), emptyProfile("acme/a"));
    recordRepoProfile("rp", signalsFor(discovered("b")), emptyProfile("acme/b"));
    setRepoEnriched("rp", "acme/a");
    pauseProfileRun("rp");

    const { deps, state } = serviceDeps([discovered("a"), discovered("b")]);
    const resumed = resumeProfileRun("rp", deps);
    expect(resumed?.state).toBe("running"); // the reset runs synchronously
    await state.runPromise;

    expect(getProfileRun("rp")?.state).toBe("completed");
    expect([...getEnrichedRepoNames("rp")].sort()).toEqual(["acme/a", "acme/b"]);
  });

  test("resumeProfileRun leaves a completed run alone and returns null for unknown", () => {
    createProfileRun({ id: "done", sourceApiUrl: "u", org: "acme" });
    completeProfileRun("done");
    const { deps, state } = serviceDeps([discovered("a")]);
    expect(resumeProfileRun("done", deps)?.state).toBe("completed");
    expect(state.gqlBuilt).toBe(0); // nothing was re-dispatched
    expect(resumeProfileRun("missing", deps)).toBeNull();
  });
});

describe("requestEnterprisePause / resumeEnterpriseRun", () => {
  test("requestEnterprisePause flags the enterprise and its running children", () => {
    createEnterpriseRun({ id: "ent", sourceApiUrl: "u", enterpriseSlug: "acme-inc" });
    createProfileRun({ id: "c-run", sourceApiUrl: "u", org: "run", enterpriseRunId: "ent" });
    createProfileRun({ id: "c-done", sourceApiUrl: "u", org: "done", enterpriseRunId: "ent" });
    completeProfileRun("c-done");

    const run = requestEnterprisePause("ent");
    expect(run?.id).toBe("ent");
    expect(isPauseRequested("ent")).toBe(true);
    expect(isPauseRequested("c-run")).toBe(true); // the running child is paused too
    expect(isPauseRequested("c-done")).toBe(false); // a settled child is left alone
    clearPause("ent");
    clearPause("c-run");
  });

  test("requestEnterprisePause is a no-op for a settled run and null for unknown", () => {
    createEnterpriseRun({ id: "ent", sourceApiUrl: "u", enterpriseSlug: "acme-inc" });
    completeEnterpriseRun("ent");
    expect(requestEnterprisePause("ent")?.state).toBe("completed");
    expect(isPauseRequested("ent")).toBe(false);
    expect(requestEnterprisePause("missing")).toBeNull();
  });

  test("resumeEnterpriseRun continues a paused enterprise to completion", async () => {
    createEnterpriseRun({ id: "ent", sourceApiUrl: "u", enterpriseSlug: "acme-inc" });
    createProfileRun({ id: "c-done", sourceApiUrl: "u", org: "done", enterpriseRunId: "ent" });
    completeProfileRun("c-done");
    createProfileRun({ id: "c-stop", sourceApiUrl: "u", org: "stop", enterpriseRunId: "ent" });
    pauseProfileRun("c-stop");
    pauseEnterpriseRun("ent");

    const { deps, state } = serviceDeps([discovered("a")], {}, ["done", "stop"]);
    const resumed = resumeEnterpriseRun("ent", deps);
    expect(resumed?.state).toBe("running"); // the reset runs synchronously
    await state.runPromise;

    expect(getEnterpriseRun("ent")?.state).toBe("completed");
    const children = getEnterpriseChildRuns("ent");
    expect(children.map((c) => c.org).sort()).toEqual(["done", "stop"]);
    expect(children.find((c) => c.org === "done")?.id).toBe("c-done"); // not re-run
    expect(children.find((c) => c.org === "stop")?.state).toBe("completed"); // resumed
  });

  test("resumeEnterpriseRun leaves a completed run alone and returns null for unknown", () => {
    createEnterpriseRun({ id: "ent", sourceApiUrl: "u", enterpriseSlug: "acme-inc" });
    completeEnterpriseRun("ent");
    const { deps, state } = serviceDeps([discovered("a")], {}, ["x"]);
    expect(resumeEnterpriseRun("ent", deps)?.state).toBe("completed");
    expect(state.gqlBuilt).toBe(0); // nothing was re-dispatched
    expect(resumeEnterpriseRun("missing", deps)).toBeNull();
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
