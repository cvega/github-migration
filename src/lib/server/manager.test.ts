/**
 * Characterization tests for the concurrency manager's orchestration logic:
 * the per-org concurrency cap, FIFO queue promotion, cancel, restart, and
 * crash recovery.
 *
 * The pipeline runner (which performs real GitHub network/disk I/O) is
 * replaced via __setPipelineRunnerForTests with an inert stub that never
 * settles, so a "running" migration holds its slot open for as long as the
 * test needs without touching the network. Each test runs against a fresh
 * in-memory database.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BatchMigrationRequest, CreateMigrationRequest, Migration } from "../types";
import {
  __setPipelineRunnerForTests,
  cancel,
  events,
  get,
  recoverOrphans,
  restart,
  start,
  startBatch,
} from "./manager";
import { initStore, insertMigration } from "./store";

const MAX_CONCURRENT = 10;

/** IDs passed to the (stubbed) pipeline runner / resumer. */
let launched: string[] = [];
let resumed: string[] = [];
let restorePipeline: () => void;

function req(repo: string): CreateMigrationRequest {
  return { sourceRepo: repo, targetOrg: "acme-cloud", sourceToken: "s", targetToken: "t" };
}

function batchReq(n: number): BatchMigrationRequest {
  return {
    repos: Array.from({ length: n }, (_, i) => `acme/repo-${i}`),
    targetOrg: "acme-cloud",
    sourceToken: "s",
    targetToken: "t",
  };
}

function makeRow(over: Partial<Migration>): Migration {
  return {
    id: "seed-row",
    batchId: null,
    githubMigrationId: null,
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
    startedAt: "2026-06-01T00:00:00.000Z",
    completedAt: null,
    elapsedSeconds: null,
    authMode: null,
    requestOptions: null,
    ...over,
  };
}

/** Narrow `T | undefined` to `T`, failing the test with a clear message if absent. */
function defined<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

beforeEach(() => {
  initStore(":memory:");
  launched = [];
  resumed = [];
  restorePipeline = __setPipelineRunnerForTests({
    // Never settles — the migration stays "running" and holds its slot.
    run: (opts) => {
      if (opts.id) launched.push(opts.id);
      return new Promise<Migration>(() => {});
    },
    resume: (migration) => {
      resumed.push(migration.id);
      return new Promise<Migration>(() => {});
    },
  });
});

afterEach(() => {
  restorePipeline();
});

describe("start + concurrency cap", () => {
  test("start launches the pipeline and returns a pending migration", () => {
    const m = start(req("acme/widget"));
    expect(m.state).toBe("pending");
    expect(launched).toContain(m.id);
    expect(get(m.id)?.state).toBe("pending");
  });

  test("allows up to MAX_CONCURRENT active migrations", () => {
    for (let i = 0; i < MAX_CONCURRENT; i++) {
      expect(() => start(req(`acme/repo-${i}`))).not.toThrow();
    }
    expect(launched).toHaveLength(MAX_CONCURRENT);
  });

  test("rejects the migration that would exceed the cap", () => {
    for (let i = 0; i < MAX_CONCURRENT; i++) start(req(`acme/repo-${i}`));
    expect(() => start(req("acme/one-too-many"))).toThrow(/Concurrency limit reached/);
  });
});

describe("startBatch", () => {
  test("starts up to the cap and queues the overflow", () => {
    const summary = startBatch(batchReq(MAX_CONCURRENT + 2));
    expect(summary.totalCount).toBe(MAX_CONCURRENT + 2);
    expect(summary.pendingCount).toBe(MAX_CONCURRENT);
    expect(summary.queuedCount).toBe(2);
    expect(launched).toHaveLength(MAX_CONCURRENT);
  });

  test("skips blank repo entries", () => {
    const summary = startBatch({
      repos: ["acme/a", "  ", "acme/b", ""],
      targetOrg: "acme-cloud",
      sourceToken: "s",
      targetToken: "t",
    });
    expect(summary.totalCount).toBe(2);
  });
});

describe("cancel + queue promotion", () => {
  test("cancelling a running migration promotes the next queued one (FIFO drain)", () => {
    const summary = startBatch(batchReq(MAX_CONCURRENT + 1));
    const queued = defined(
      summary.migrations.find((m) => m.state === "queued"),
      "expected a queued migration",
    );
    const running = defined(
      summary.migrations.find((m) => m.state === "pending"),
      "expected a pending migration",
    );

    const ok = cancel(running.id);
    expect(ok).toBe(true);
    expect(get(running.id)?.state).toBe("cancelled");
    // A slot freed up, so the queued migration is promoted to pending.
    expect(get(queued.id)?.state).toBe("pending");
    expect(launched).toContain(queued.id);
  });

  test("cancelling a queued migration removes it without promoting itself", () => {
    const summary = startBatch(batchReq(MAX_CONCURRENT + 1));
    const queued = defined(
      summary.migrations.find((m) => m.state === "queued"),
      "expected a queued migration",
    );

    const ok = cancel(queued.id);
    expect(ok).toBe(true);
    expect(get(queued.id)?.state).toBe("cancelled");
  });

  test("cancel returns false for an unknown migration", () => {
    expect(cancel("does-not-exist")).toBe(false);
  });
});

describe("restart", () => {
  test("throws for an unknown migration", () => {
    expect(() => restart("nope", {})).toThrow(/not found/i);
  });

  test("refuses to restart a migration that is not failed or cancelled", () => {
    const m = start(req("acme/widget"));
    expect(() => restart(m.id, {})).toThrow(/Cannot restart/);
  });

  test("re-runs a cancelled migration and records a restart event", () => {
    const m = start(req("acme/widget"));
    cancel(m.id);
    expect(get(m.id)?.state).toBe("cancelled");

    const restarted = restart(m.id, { sourceToken: "s", targetToken: "t" });
    expect(restarted.state).toBe("pending");
    expect(launched.filter((id) => id === m.id)).toHaveLength(2); // initial + restart
    expect(events(m.id).some((e) => e.eventType === "restart")).toBe(true);
  });

  test("queues a restart when already at the concurrency cap", () => {
    // One migration we will cancel, then fill every slot.
    const victim = start(req("acme/victim"));
    cancel(victim.id);
    for (let i = 0; i < MAX_CONCURRENT; i++) start(req(`acme/repo-${i}`));

    const restarted = restart(victim.id, { sourceToken: "s", targetToken: "t" });
    expect(restarted.state).toBe("queued");
  });
});

describe("recoverOrphans", () => {
  test("resumes interrupted env-auth migrations that have a github_migration_id", () => {
    insertMigration(
      makeRow({
        id: "orphan-1",
        state: "running",
        authMode: "env-app",
        githubMigrationId: "RM_kgDOorphan",
      }),
    );
    recoverOrphans();
    expect(resumed).toContain("orphan-1");
  });

  test("does not resume PAT-auth migrations (credentials are lost on restart)", () => {
    insertMigration(
      makeRow({ id: "orphan-pat", state: "running", authMode: "pat", githubMigrationId: "RM_x" }),
    );
    recoverOrphans();
    expect(resumed).not.toContain("orphan-pat");
  });
});
