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
import type { Migration, MigrationEvent, Phase } from "../types";

// ── Module mocks ────────────────────────────────────────────────────────────
// runMonitor's terminal phase is the key input that drives finalize; each test
// sets it. abortMigration records whether GHEC abort was attempted.

let monitorPhase: Phase = "SUCCEEDED";
let monitorImpl: () => Promise<Phase> = async () => monitorPhase;
let abortCalls = 0;
let repoCountsImpl: () => Promise<unknown> = async () => ({
  commits: 10,
  branches: 1,
  tags: 0,
  issues: 2,
  pullRequests: 1,
  releases: 0,
});

mock.module("$lib/server/monitor", () => ({
  runMonitor: () => monitorImpl(),
}));

// Spread the real github module so unrelated exports (used by auth.ts etc.)
// keep working; override only the functions the finalize tail calls.
const realGithub = await import("./github");
mock.module("$lib/server/github", () => ({
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

mock.module("$lib/server/store", () => ({
  updateCheckpoint: () => {},
  updateMigrationSourceSize: () => {},
}));

// Env auth so resolveSourceAuth()/resolveTargetAuth() (no-arg, env path) succeed.
process.env.GH_SOURCE_PAT = "ghp_source_test";
process.env.GH_TARGET_PAT = "ghp_target_test";

const { resumeMigration } = await import("./migration");

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
    ...over,
  };
}

let events: MigrationEvent[];
const emit = (e: MigrationEvent) => {
  events.push(e);
};

beforeEach(() => {
  events = [];
  abortCalls = 0;
  monitorPhase = "SUCCEEDED";
  monitorImpl = async () => monitorPhase;
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
});
