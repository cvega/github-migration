/**
 * Tests for the Profile persistence layer. Each runs against a fresh in-memory
 * database (initStore(":memory:")), mirroring store.test.ts. Profiles are
 * hand-built so the run-aggregate recomputation (blockers/warnings) can be
 * exercised independently of which considerations the analysis engine can
 * currently detect.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { type Consideration, MIGRATION_CONSIDERATIONS } from "$lib/profile/consideration-registry";
import { initStore } from "$lib/server/core/db";
import { DOMAIN_STORES } from "$lib/server/registry";
import type { RepoProfile } from "./analyze";
import {
  completeProfileRun,
  createProfileRun,
  failProfileRun,
  getProfileRun,
  getRunRepoProfiles,
  listProfileRuns,
  recordRepoProfile,
  setProfileRunApiCalls,
  setProfileRunOrgResources,
  setProfileRunRulesets,
  setProfileRunTotal,
} from "./store";
import type { RepoSignals } from "./types";

const considerationById = (id: string): Consideration => {
  const consideration = MIGRATION_CONSIDERATIONS.find((g) => g.id === id);
  if (!consideration) throw new Error(`test consideration id not in registry: ${id}`);
  return consideration;
};

function signals(over: Partial<RepoSignals> = {}): RepoSignals {
  return {
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
    issuesCount: 0,
    pullRequestsCount: 0,
    branchesCount: 0,
    tagsCount: 0,
    commitsCount: 0,
    discussionsCount: 0,
    projectsV2Count: 0,
    environmentsCount: 0,
    releasesCount: 0,
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
    hasCodeScanningAlerts: false,
    ...over,
  };
}

/** Hand-build a RepoProfile with explicit severity counts and applying considerations. */
function profile(
  nameWithOwner: string,
  opts: {
    blockers?: number;
    warnings?: number;
    infos?: number;
    applying?: Array<{ considerationId: string; evidence: string }>;
  } = {},
): RepoProfile {
  const applying = opts.applying ?? [];
  return {
    nameWithOwner,
    findings: applying.map((a) => ({
      consideration: considerationById(a.considerationId),
      status: "applies" as const,
      evidence: a.evidence,
    })),
    summary: {
      applies: applying.length,
      blockers: opts.blockers ?? 0,
      warnings: opts.warnings ?? 0,
      infos: opts.infos ?? 0,
      clear: 0,
      indeterminate: 0,
    },
  };
}

beforeEach(() => {
  initStore(":memory:", DOMAIN_STORES);
});

describe("createProfileRun / getProfileRun", () => {
  test("creates a run in the running state with the given identity", () => {
    const run = createProfileRun({
      id: "run-1",
      sourceApiUrl: "https://ghes.example.com/api/v3",
      org: "acme",
      nowMs: Date.parse("2026-06-13T12:00:00Z"),
    });

    expect(run).toMatchObject({
      id: "run-1",
      sourceApiUrl: "https://ghes.example.com/api/v3",
      org: "acme",
      state: "running",
      totalRepos: 0,
      profiledRepos: 0,
      blockers: 0,
      warnings: 0,
      completedAt: null,
      failureReason: null,
    });
    expect(run.startedAt).toBe("2026-06-13T12:00:00.000Z");
    expect(getProfileRun("run-1")).toEqual(run);
  });

  test("returns null for an unknown run", () => {
    expect(getProfileRun("nope")).toBeNull();
  });
});

describe("setProfileRunTotal", () => {
  test("records the org repository total", () => {
    createProfileRun({ id: "r", sourceApiUrl: "u", org: "acme" });
    setProfileRunTotal("r", 42);
    expect(getProfileRun("r")?.totalRepos).toBe(42);
  });
});

describe("setProfileRunRulesets", () => {
  test("records the org ruleset count (default 0)", () => {
    createProfileRun({ id: "r", sourceApiUrl: "u", org: "acme" });
    expect(getProfileRun("r")?.orgRulesetCount).toBe(0);
    setProfileRunRulesets("r", 4);
    expect(getProfileRun("r")?.orgRulesetCount).toBe(4);
  });
});

describe("setProfileRunApiCalls", () => {
  test("records the run's API-call total (default 0)", () => {
    createProfileRun({ id: "r", sourceApiUrl: "u", org: "acme" });
    expect(getProfileRun("r")?.apiCalls).toBe(0);
    setProfileRunApiCalls("r", 1234);
    expect(getProfileRun("r")?.apiCalls).toBe(1234);
  });
});

describe("setProfileRunOrgResources", () => {
  test("defaults to all-zero resources before gathering", () => {
    createProfileRun({ id: "r", sourceApiUrl: "u", org: "acme" });
    expect(getProfileRun("r")?.orgResources).toEqual({
      actionsSecrets: 0,
      actionsVariables: 0,
      dependabotSecrets: 0,
      codespacesSecrets: 0,
      selfHostedRunners: 0,
      customProperties: 0,
    });
  });

  test("round-trips the gathered resource counts", () => {
    createProfileRun({ id: "r", sourceApiUrl: "u", org: "acme" });
    setProfileRunOrgResources("r", {
      actionsSecrets: 3,
      actionsVariables: 1,
      dependabotSecrets: 2,
      codespacesSecrets: 0,
      selfHostedRunners: 4,
      customProperties: 5,
    });
    expect(getProfileRun("r")?.orgResources).toMatchObject({
      actionsSecrets: 3,
      dependabotSecrets: 2,
      selfHostedRunners: 4,
      customProperties: 5,
    });
  });
});

describe("recordRepoProfile / getRunRepoProfiles", () => {
  test("round-trips signals, severity counts, and applying considerations", () => {
    createProfileRun({ id: "r", sourceApiUrl: "u", org: "acme" });
    recordRepoProfile(
      "r",
      signals({ nameWithOwner: "acme/widget", discussionsCount: 3 }),
      profile("acme/widget", {
        warnings: 1,
        infos: 1,
        applying: [
          { considerationId: "discussions", evidence: "3 discussions" },
          { considerationId: "fork-relationships", evidence: "repository is a fork" },
        ],
      }),
    );

    const repos = getRunRepoProfiles("r");
    expect(repos).toHaveLength(1);
    expect(repos[0]).toMatchObject({
      nameWithOwner: "acme/widget",
      warnings: 1,
      infos: 1,
      applyingConsiderations: [
        { considerationId: "discussions", evidence: "3 discussions" },
        { considerationId: "fork-relationships", evidence: "repository is a fork" },
      ],
    });
    expect(repos[0]?.signals.discussionsCount).toBe(3);
  });

  test("is idempotent on (run, repo) — re-recording updates in place", () => {
    createProfileRun({ id: "r", sourceApiUrl: "u", org: "acme" });
    recordRepoProfile("r", signals(), profile("acme/widget", { warnings: 1 }));
    recordRepoProfile("r", signals(), profile("acme/widget", { warnings: 5 }));

    const repos = getRunRepoProfiles("r");
    expect(repos).toHaveLength(1);
    expect(repos[0]?.warnings).toBe(5);
  });

  test("orders repos by name", () => {
    createProfileRun({ id: "r", sourceApiUrl: "u", org: "acme" });
    recordRepoProfile("r", signals({ nameWithOwner: "acme/zeta" }), profile("acme/zeta"));
    recordRepoProfile("r", signals({ nameWithOwner: "acme/alpha" }), profile("acme/alpha"));

    expect(getRunRepoProfiles("r").map((p) => p.nameWithOwner)).toEqual([
      "acme/alpha",
      "acme/zeta",
    ]);
  });
});

describe("completeProfileRun", () => {
  test("recomputes profiledRepos and severity sums, then marks completed", () => {
    createProfileRun({ id: "r", sourceApiUrl: "u", org: "acme" });
    recordRepoProfile(
      "r",
      signals({ nameWithOwner: "acme/a" }),
      profile("acme/a", { blockers: 1, warnings: 2 }),
    );
    recordRepoProfile(
      "r",
      signals({ nameWithOwner: "acme/b" }),
      profile("acme/b", { blockers: 2, warnings: 1 }),
    );

    completeProfileRun("r", Date.parse("2026-06-13T13:00:00Z"));

    const run = getProfileRun("r");
    expect(run?.state).toBe("completed");
    expect(run?.profiledRepos).toBe(2);
    expect(run?.blockers).toBe(3);
    expect(run?.warnings).toBe(3);
    expect(run?.completedAt).toBe("2026-06-13T13:00:00.000Z");
  });

  test("aggregates reflect upserts, not write count (resume-safe)", () => {
    createProfileRun({ id: "r", sourceApiUrl: "u", org: "acme" });
    // Same repo recorded twice (as a resume would) must count once.
    recordRepoProfile(
      "r",
      signals({ nameWithOwner: "acme/a" }),
      profile("acme/a", { blockers: 5 }),
    );
    recordRepoProfile(
      "r",
      signals({ nameWithOwner: "acme/a" }),
      profile("acme/a", { blockers: 1 }),
    );

    completeProfileRun("r");

    const run = getProfileRun("r");
    expect(run?.profiledRepos).toBe(1);
    expect(run?.blockers).toBe(1);
  });
});

describe("failProfileRun", () => {
  test("marks the run failed with a reason", () => {
    createProfileRun({ id: "r", sourceApiUrl: "u", org: "acme" });
    failProfileRun("r", "discovery failed: org not found", Date.parse("2026-06-13T13:00:00Z"));

    const run = getProfileRun("r");
    expect(run?.state).toBe("failed");
    expect(run?.failureReason).toBe("discovery failed: org not found");
    expect(run?.completedAt).toBe("2026-06-13T13:00:00.000Z");
  });
});

describe("listProfileRuns", () => {
  test("returns runs most-recent-first and respects the limit", () => {
    createProfileRun({
      id: "old",
      sourceApiUrl: "u",
      org: "a",
      nowMs: Date.parse("2026-06-13T10:00:00Z"),
    });
    createProfileRun({
      id: "new",
      sourceApiUrl: "u",
      org: "b",
      nowMs: Date.parse("2026-06-13T12:00:00Z"),
    });
    createProfileRun({
      id: "mid",
      sourceApiUrl: "u",
      org: "c",
      nowMs: Date.parse("2026-06-13T11:00:00Z"),
    });

    expect(listProfileRuns().map((r) => r.id)).toEqual(["new", "mid", "old"]);
    expect(listProfileRuns(2).map((r) => r.id)).toEqual(["new", "mid"]);
  });

  test("is empty when no runs exist", () => {
    expect(listProfileRuns()).toEqual([]);
  });
});
