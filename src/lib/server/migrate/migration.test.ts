/**
 * Characterization tests for the migration pipeline's *finalize* behavior —
 * the shared "monitor → terminal-phase check → final counts → success/failure/
 * cancel → emit" tail of runMigrationPipeline and resumeMigration (jscpd
 * clones #2–6). These lock in the current outcomes so that tail can later be
 * safely de-duplicated.
 *
 * The pipeline does real GitHub I/O, so its module boundaries (./github,
 * ./monitor, ./store) are mocked. We drive resumeMigration (the smaller entry
 * point that still exercises the full finalize tail) through each terminal
 * outcome and assert the resulting Migration record + emitted events.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Counts, Migration, MigrationEvent, Phase } from "$lib/types";
import { initStore } from "../core/db";
import { DOMAIN_STORES } from "../registry";
import type { MigrationPipelineOpts } from "./migration";

// ── Module mocks ────────────────────────────────────────────────────────────
// runMonitor's terminal phase is the key input that drives finalize; each test
// sets it. abortMigration records whether GHEC abort was attempted.

let monitorPhase: Phase = "SUCCEEDED";
// Counts the monitor captured in its final snapshot. When null, finalize falls
// back to a getRepoCounts re-fetch (the default for most finalize tests).
let monitorFinalCounts: Counts | null = null;
let monitorImpl: () => Promise<{ phase: Phase; finalCounts: Counts | null }> = async () => ({
  phase: monitorPhase,
  finalCounts: monitorFinalCounts,
});
let abortCalls = 0;
let repoCountsImpl: () => Promise<unknown> = async () => ({
  commits: 10,
  branches: 1,
  tags: 0,
  issues: 2,
  pullRequests: 1,
  releases: 0,
});

// monitor is only ever imported by migration.ts, which these tests drive with
// this mock — no suite imports the real monitor — so a partial stub here can't
// leak harmfully, and importing the real module just to spread it would pull
// monitor.ts (untested on its own) into the coverage denominator. Keep it lean.
mock.module("$lib/server/migrate/monitor", () => ({
  runMonitor: () => monitorImpl(),
}));

// Spread the real github module so unrelated exports (used by auth.ts etc.)
// keep working; override only the functions the finalize tail calls.
const realGithub = await import("../core/github");
mock.module("$lib/server/core/github", () => ({
  ...realGithub,
  createClients: () => ({
    source: {},
    target: {},
    sourceGraphql: {},
    targetGraphql: {},
  }),
  getRepoCounts: () => repoCountsImpl(),
  abortMigration: async () => {
    abortCalls += 1;
    return true;
  },
}));

// The store is REAL against an in-memory DB (initialized per-test in
// beforeEach), NOT mocked. `mock.module` is global and permanent for the whole
// `bun test` run — mock.restore() does not undo it — so stubbing the store here
// would leak no-op writers into store.test.ts, which exercises those same
// functions for real. Using a real in-memory store keeps this suite hermetic
// without poisoning any other: migration.ts only ever *writes* to the store
// (updateCheckpoint/updateMigrationProvenance/updateMigrationSourceSize), never
// reads, so the writes simply land in the throwaway in-memory DB.

// Env auth so resolveSourceAuth()/resolveTargetAuth() (no-arg, env path) succeed.
process.env.GH_SOURCE_PAT = "ghp_source_test";
process.env.GH_TARGET_PAT = "ghp_target_test";

const { resumeMigration, assertTrustedHost, determineAuthMode } = await import("./migration");

function makeMigration(over: Partial<Migration> = {}): Migration {
  return {
    id: "resume-1",
    batchId: null,
    githubMigrationId: "RM_kgDOtest",
    sourceApiUrl: "https://api.github.com",
    sourceOrg: "acme",
    sourceRepo: "widget",
    targetOrg: "acme-cloud",
    targetRepo: "widget",
    state: "running",
    failureReason: null,
    migrationLogUrl: null,
    warningsCount: 0,
    sourceCounts: null,
    targetCounts: null,
    sourceSizeKb: null,
    startedAt: new Date(Date.now() - 5000).toISOString(),
    completedAt: null,
    elapsedSeconds: null,
    authMode: "env-pat",
    requestOptions: null,
    targetPreexisted: null,
    targetRepoNodeId: null,
    ...over,
  };
}

let events: MigrationEvent[];
const emit = (e: MigrationEvent) => {
  events.push(e);
};

beforeEach(() => {
  initStore(":memory:", DOMAIN_STORES);
  events = [];
  abortCalls = 0;
  monitorPhase = "SUCCEEDED";
  monitorFinalCounts = null;
  monitorImpl = async () => ({ phase: monitorPhase, finalCounts: monitorFinalCounts });
  repoCountsImpl = async () => ({
    commits: 10,
    branches: 1,
    tags: 0,
    issues: 2,
    pullRequests: 1,
    releases: 0,
  });
});

afterEach(() => {
  mock.restore();
});

describe("resumeMigration finalize", () => {
  test("SUCCEEDED → succeeded with timing and target counts, no failure event", async () => {
    monitorPhase = "SUCCEEDED";
    const result = await resumeMigration(makeMigration(), emit);

    expect(result.state).toBe("succeeded");
    expect(result.completedAt).not.toBeNull();
    expect(result.elapsedSeconds).toBeGreaterThan(0);
    expect(result.targetCounts).toEqual({
      commits: 10,
      branches: 1,
      tags: 0,
      issues: 2,
      pullRequests: 1,
      releases: 0,
    });
    expect(events.some((e) => e.eventType === "failure")).toBe(false);
  });

  test("prefers the monitor's final snapshot counts over a re-fetch (indexing-lag guard)", async () => {
    monitorPhase = "SUCCEEDED";
    // The monitor's final snapshot captured the true counts...
    monitorFinalCounts = {
      commits: 1,
      branches: 3,
      tags: 0,
      issues: 4,
      pullRequests: 2,
      releases: 0,
    };
    // ...while a post-success re-fetch would return transient zeros (GHEC lag).
    let refetched = false;
    repoCountsImpl = async () => {
      refetched = true;
      return { commits: 1, branches: 3, tags: 0, issues: 0, pullRequests: 0, releases: 0 };
    };

    const result = await resumeMigration(makeMigration(), emit);

    expect(result.state).toBe("succeeded");
    // Snapshot counts win; the laggy re-fetch is not consulted.
    expect(result.targetCounts).toEqual(monitorFinalCounts);
    expect(refetched).toBe(false);
  });

  test("FAILED → failed with a reason and timing", async () => {
    monitorPhase = "FAILED";
    const result = await resumeMigration(makeMigration(), emit);

    expect(result.state).toBe("failed");
    expect(result.failureReason).toBe("Migration failed on GHEC");
    expect(result.completedAt).not.toBeNull();
    expect(result.elapsedSeconds).toBeGreaterThan(0);
  });

  test("non-terminal phase (UNKNOWN) → failed via thrown error", async () => {
    monitorPhase = "UNKNOWN";
    const result = await resumeMigration(makeMigration(), emit);

    expect(result.state).toBe("failed");
    expect(result.failureReason).toContain("Monitor exited in phase UNKNOWN");
    // A genuine error emits a failure event.
    expect(events.some((e) => e.eventType === "failure")).toBe(true);
  });

  test("aborted signal → cancelled, and NO failure event is emitted", async () => {
    const controller = new AbortController();
    // Monitor rejects (as it would when aborted mid-poll); signal is aborted.
    monitorImpl = async () => {
      controller.abort();
      throw new Error("Migration cancelled");
    };
    const result = await resumeMigration(makeMigration(), emit, controller.signal);

    expect(result.state).toBe("cancelled");
    expect(events.some((e) => e.eventType === "failure")).toBe(false);
    expect(result.completedAt).not.toBeNull();
    // Unlike runMigrationPipeline, resume does not attempt a GHEC abort.
    expect(abortCalls).toBe(0);
  });

  test("final-count fetch failure is non-fatal (still succeeds)", async () => {
    monitorPhase = "SUCCEEDED";
    repoCountsImpl = async () => {
      throw new Error("counts API down");
    };
    const result = await resumeMigration(makeMigration(), emit);

    expect(result.state).toBe("succeeded");
    expect(result.targetCounts).toBeNull();
  });

  test("missing githubMigrationId rejects with a precondition error", async () => {
    await expect(resumeMigration(makeMigration({ githubMigrationId: null }), emit)).rejects.toThrow(
      /missing githubMigrationId/,
    );
  });
});

// ── assertTrustedHost (SSRF / credential-leak guard) ──────────────────────────
// Before sending the source Bearer token to an archive download URL, the
// pipeline asserts the URL's host matches the source API host. Pure URL logic.

describe("assertTrustedHost", () => {
  const sourceApi = "https://ghes.example.com/api/v3";

  test("passes when the download host matches the source host", () => {
    expect(() =>
      assertTrustedHost("https://ghes.example.com/storage/archive.tar.gz", sourceApi),
    ).not.toThrow();
  });

  test("throws, naming both hosts, when the download host differs", () => {
    expect(() => assertTrustedHost("https://evil.example.com/archive.tar.gz", sourceApi)).toThrow(
      /Refusing to send credentials to evil\.example\.com — expected ghes\.example\.com/,
    );
  });

  test("a mismatched subdomain is still rejected", () => {
    expect(() => assertTrustedHost("https://cdn.ghes.example.com/a", sourceApi)).toThrow();
  });

  test("compares hostname only — port, path, and scheme differences pass", () => {
    expect(() =>
      assertTrustedHost("http://ghes.example.com:8443/deep/path?x=1", sourceApi),
    ).not.toThrow();
  });
});

// ── determineAuthMode (crash-recovery eligibility) ───────────────────────────
// Decides which auth mode a migration ran under, gating whether it can be
// resumed after a restart. Reads request opts first, then env config.

describe("determineAuthMode", () => {
  const AUTH_ENV_KEYS = [
    "GH_SOURCE_PAT",
    "GH_TARGET_PAT",
    "GH_SOURCE_APP_ID",
    "GH_SOURCE_APP_PRIVATE_KEY",
    "GH_SOURCE_APP_INSTALLATION_ID",
    "GH_TARGET_APP_ID",
    "GH_TARGET_APP_PRIVATE_KEY",
    "GH_TARGET_APP_INSTALLATION_ID",
  ] as const;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    // Snapshot and clear all auth env so each case starts from a known state.
    savedEnv = {};
    for (const key of AUTH_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    // Restore exactly, so we don't leak into resumeMigration tests or other files.
    for (const key of AUTH_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  function opts(over: Partial<MigrationPipelineOpts> = {}): MigrationPipelineOpts {
    return { sourceRepo: "acme/widget", targetOrg: "acme-cloud", emit: () => {}, ...over };
  }

  function setEnvApp(side: "SOURCE" | "TARGET"): void {
    process.env[`GH_${side}_APP_ID`] = "123";
    process.env[`GH_${side}_APP_PRIVATE_KEY`] = "-----BEGIN PRIVATE KEY-----";
    process.env[`GH_${side}_APP_INSTALLATION_ID`] = "456";
  }

  test("a request token means request-pat auth", () => {
    expect(determineAuthMode(opts({ sourceToken: "ghp_x" }))).toBe("request-pat");
    expect(determineAuthMode(opts({ targetToken: "ghp_y" }))).toBe("request-pat");
  });

  test("request app credentials (no tokens) mean request-app", () => {
    const app = { appId: "1", privateKey: "-----KEY-----", installationId: "2" };
    expect(determineAuthMode(opts({ sourceApp: app }))).toBe("request-app");
    expect(determineAuthMode(opts({ targetApp: app }))).toBe("request-app");
  });

  test("env apps on both sides mean env-app (resumable)", () => {
    setEnvApp("SOURCE");
    setEnvApp("TARGET");
    expect(determineAuthMode(opts())).toBe("env-app");
  });

  test("a single-sided env app falls through (not env-app)", () => {
    setEnvApp("SOURCE");
    // Target has no auth at all → no env-app, no env-pat → request-pat.
    expect(determineAuthMode(opts())).toBe("request-pat");
  });

  test("env PATs on both sides mean env-pat", () => {
    process.env.GH_SOURCE_PAT = "ghp_s";
    process.env.GH_TARGET_PAT = "ghp_t";
    expect(determineAuthMode(opts())).toBe("env-pat");
  });

  test("no credentials anywhere defaults to request-pat", () => {
    expect(determineAuthMode(opts())).toBe("request-pat");
  });

  test("a request token takes precedence over configured env apps", () => {
    setEnvApp("SOURCE");
    setEnvApp("TARGET");
    expect(determineAuthMode(opts({ sourceToken: "ghp_x" }))).toBe("request-pat");
  });
});
