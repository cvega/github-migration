/**
 * Characterization tests for the SQLite persistence layer.
 *
 * Each test runs against a fresh in-memory database (initStore(":memory:")
 * reassigns the module-level connection), so cases are fully isolated and no
 * disk/network is touched.
 *
 * Note: insertMigration() only writes a subset of columns — lifecycle fields
 * (elapsed_seconds, completed_at, warnings_count, failure_reason, source_size_kb)
 * take their schema defaults and are set afterwards via the update helpers,
 * mirroring how the app drives a migration through its lifecycle.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { Counts, Migration } from "../types";
import {
  getActiveMigrationCount,
  getBatchListItem,
  getBatchMigrations,
  getBatchSummary,
  getEvents,
  getMigration,
  getMigrationStats,
  getNextQueuedMigration,
  getQueuedEnvMigrations,
  getRecoverableMigrations,
  initStore,
  insertEvent,
  insertMigration,
  listMigrationsPaginated,
  resetMigration,
  updateCheckpoint,
  updateMigrationSourceSize,
  updateMigrationState,
} from "./store";

let idCounter = 0;

function counts(over: Partial<Counts> = {}): Counts {
  return { commits: 0, branches: 0, tags: 0, issues: 0, pullRequests: 0, releases: 0, ...over };
}

function makeMigration(over: Partial<Migration> = {}): Migration {
  idCounter += 1;
  return {
    id: `mig-${idCounter}`,
    batchId: null,
    githubMigrationId: null,
    sourceApiUrl: "https://api.github.com",
    sourceOrg: "acme",
    sourceRepo: "widget",
    targetOrg: "acme-cloud",
    targetRepo: "widget",
    state: "queued",
    failureReason: null,
    migrationLogUrl: null,
    warningsCount: 0,
    sourceCounts: null,
    targetCounts: null,
    sourceSizeKb: null,
    startedAt: "2026-06-01T10:00:00.000Z",
    completedAt: null,
    elapsedSeconds: null,
    authMode: null,
    requestOptions: null,
    ...over,
  };
}

beforeEach(() => {
  initStore(":memory:");
});

describe("insertMigration / getMigration round-trip", () => {
  test("returns null for an unknown id", () => {
    expect(getMigration("does-not-exist")).toBeNull();
  });

  test("persists and reads back core fields with correct types", () => {
    const m = makeMigration({
      id: "rt-1",
      githubMigrationId: "RM_kgDOABCDxyz",
      batchId: "batch-1",
      sourceOrg: "octo",
      sourceRepo: "demo",
      state: "running",
      sourceCounts: counts({ commits: 42, issues: 3 }),
      authMode: "env-app",
    });
    insertMigration(m);

    const got = getMigration("rt-1");
    expect(got).not.toBeNull();
    expect(got?.id).toBe("rt-1");
    expect(got?.githubMigrationId).toBe("RM_kgDOABCDxyz");
    expect(got?.batchId).toBe("batch-1");
    expect(got?.state).toBe("running");
    expect(got?.authMode).toBe("env-app");
    expect(got?.sourceCounts).toEqual(counts({ commits: 42, issues: 3 }));
  });

  test("applies schema defaults for columns insertMigration does not write", () => {
    insertMigration(makeMigration({ id: "rt-2", warningsCount: 99, elapsedSeconds: 500 }));
    const got = getMigration("rt-2");
    // warnings_count defaults to 0; elapsed_seconds defaults to NULL.
    expect(got?.warningsCount).toBe(0);
    expect(got?.elapsedSeconds).toBeNull();
    expect(got?.completedAt).toBeNull();
    expect(got?.failureReason).toBeNull();
  });
});

describe("updateMigrationState COALESCE semantics", () => {
  test("updates provided fields and preserves omitted ones", () => {
    insertMigration(makeMigration({ id: "u-1", state: "running" }));

    updateMigrationState("u-1", "succeeded", {
      completedAt: "2026-06-01T11:00:00.000Z",
      elapsedSeconds: 360,
      warningsCount: 4,
    });
    const a = getMigration("u-1");
    expect(a?.state).toBe("succeeded");
    expect(a?.elapsedSeconds).toBe(360);
    expect(a?.warningsCount).toBe(4);

    // A second update that omits warningsCount must preserve it (COALESCE).
    updateMigrationState("u-1", "succeeded", { migrationLogUrl: "https://logs/x" });
    const b = getMigration("u-1");
    expect(b?.warningsCount).toBe(4);
    expect(b?.elapsedSeconds).toBe(360);
    expect(b?.migrationLogUrl).toBe("https://logs/x");
  });
});

describe("resetMigration", () => {
  test("explicitly clears transient fields that COALESCE cannot null out", () => {
    insertMigration(makeMigration({ id: "r-1", githubMigrationId: "RM_x", state: "running" }));
    updateMigrationState("r-1", "failed", {
      failureReason: "boom",
      completedAt: "2026-06-01T11:00:00.000Z",
      elapsedSeconds: 120,
      warningsCount: 2,
    });

    resetMigration("r-1", "queued");

    const got = getMigration("r-1");
    expect(got?.state).toBe("queued");
    expect(got?.githubMigrationId).toBeNull();
    expect(got?.failureReason).toBeNull();
    expect(got?.completedAt).toBeNull();
    expect(got?.elapsedSeconds).toBeNull();
    expect(got?.warningsCount).toBe(0);
  });
});

describe("updateCheckpoint / updateMigrationSourceSize", () => {
  test("records pipeline step, auth mode, and source size", () => {
    insertMigration(makeMigration({ id: "c-1" }));
    updateCheckpoint("c-1", "archiving", { authMode: "pat", githubMigrationId: "RM_chk" });
    updateMigrationSourceSize("c-1", 2048);

    const got = getMigration("c-1");
    expect(got?.authMode).toBe("pat");
    expect(got?.githubMigrationId).toBe("RM_chk");
    expect(got?.sourceSizeKb).toBe(2048);
  });
});

describe("getActiveMigrationCount", () => {
  test("counts only pending and running migrations", () => {
    insertMigration(makeMigration({ state: "pending" }));
    insertMigration(makeMigration({ state: "running" }));
    insertMigration(makeMigration({ state: "queued" }));
    insertMigration(makeMigration({ state: "succeeded" }));
    expect(getActiveMigrationCount()).toBe(2);
  });
});

describe("getNextQueuedMigration (FIFO)", () => {
  test("returns the oldest queued migration by started_at", () => {
    insertMigration(
      makeMigration({ id: "q-new", state: "queued", startedAt: "2026-06-02T00:00:00.000Z" }),
    );
    insertMigration(
      makeMigration({ id: "q-old", state: "queued", startedAt: "2026-06-01T00:00:00.000Z" }),
    );
    insertMigration(
      makeMigration({ id: "q-run", state: "running", startedAt: "2026-05-01T00:00:00.000Z" }),
    );

    expect(getNextQueuedMigration()?.id).toBe("q-old");
  });

  test("returns null when nothing is queued", () => {
    insertMigration(makeMigration({ state: "running" }));
    expect(getNextQueuedMigration()).toBeNull();
  });
});

describe("recovery queries", () => {
  test("getRecoverableMigrations: env auth, active, with a github_migration_id, excluding seeds", () => {
    insertMigration(
      makeMigration({
        id: "rec-1",
        state: "running",
        authMode: "env-app",
        githubMigrationId: "RM_1",
      }),
    );
    // Excluded: PAT auth.
    insertMigration(
      makeMigration({
        id: "rec-pat",
        state: "running",
        authMode: "pat",
        githubMigrationId: "RM_2",
      }),
    );
    // Excluded: no github_migration_id.
    insertMigration(makeMigration({ id: "rec-noid", state: "pending", authMode: "env-pat" }));
    // Excluded: seed row.
    insertMigration(
      makeMigration({
        id: "seed-x",
        state: "running",
        authMode: "env-app",
        githubMigrationId: "RM_3",
      }),
    );

    const ids = getRecoverableMigrations().map((m) => m.id);
    expect(ids).toEqual(["rec-1"]);
  });

  test("getQueuedEnvMigrations: queued env-auth rows excluding seeds", () => {
    insertMigration(makeMigration({ id: "qe-1", state: "queued", authMode: "env-pat" }));
    insertMigration(makeMigration({ id: "qe-pat", state: "queued", authMode: "pat" }));
    insertMigration(makeMigration({ id: "seed-q", state: "queued", authMode: "env-app" }));

    const ids = getQueuedEnvMigrations().map((m) => m.id);
    expect(ids).toEqual(["qe-1"]);
  });
});

describe("listMigrationsPaginated", () => {
  test("computes totalPages and echoes page/limit", () => {
    for (let i = 0; i < 5; i++) {
      insertMigration(makeMigration({ startedAt: `2026-06-0${i + 1}T00:00:00.000Z` }));
    }
    const result = listMigrationsPaginated({ page: 1, limit: 2 });
    expect(result.total).toBe(5);
    expect(result.totalPages).toBe(3);
    expect(result.page).toBe(1);
    expect(result.limit).toBe(2);
    expect(result.data).toHaveLength(2);
  });

  test("returns the requested page slice", () => {
    for (let i = 0; i < 3; i++) {
      insertMigration(makeMigration({ startedAt: `2026-06-0${i + 1}T00:00:00.000Z` }));
    }
    const lastPage = listMigrationsPaginated({ page: 2, limit: 2 });
    expect(lastPage.data).toHaveLength(1);
  });
});

describe("batch rollups", () => {
  beforeEach(() => {
    insertMigration(
      makeMigration({
        id: "b-c",
        batchId: "B",
        sourceRepo: "charlie",
        state: "succeeded",
        startedAt: "2026-06-03T00:00:00.000Z",
      }),
    );
    insertMigration(
      makeMigration({
        id: "b-a",
        batchId: "B",
        sourceRepo: "alpha",
        state: "failed",
        startedAt: "2026-06-01T00:00:00.000Z",
      }),
    );
    insertMigration(
      makeMigration({
        id: "b-b",
        batchId: "B",
        sourceRepo: "bravo",
        state: "running",
        startedAt: "2026-06-02T00:00:00.000Z",
      }),
    );
  });

  test("getBatchListItem aggregates per-state counts and earliest start", () => {
    const item = getBatchListItem("B");
    expect(item?.totalCount).toBe(3);
    expect(item?.succeededCount).toBe(1);
    expect(item?.failedCount).toBe(1);
    expect(item?.runningCount).toBe(1);
    expect(item?.startedAt).toBe("2026-06-01T00:00:00.000Z");
  });

  test("getBatchMigrations orders by source_repo ascending", () => {
    expect(getBatchMigrations("B").map((m) => m.sourceRepo)).toEqual(["alpha", "bravo", "charlie"]);
  });

  test("getBatchSummary embeds the migration list", () => {
    const summary = getBatchSummary("B");
    expect(summary?.totalCount).toBe(3);
    expect(summary?.migrations).toHaveLength(3);
  });

  test("getBatchListItem returns null for an unknown batch", () => {
    expect(getBatchListItem("nope")).toBeNull();
  });
});

describe("events", () => {
  test("insertEvent returns a rowid and getEvents reads payloads back in order", () => {
    insertMigration(makeMigration({ id: "ev-1" }));
    const firstId = insertEvent({
      migrationId: "ev-1",
      eventType: "milestone",
      phase: null,
      payload: { message: "first" },
      createdAt: "2026-06-01T10:00:00.000Z",
    });
    const secondId = insertEvent({
      migrationId: "ev-1",
      eventType: "milestone",
      phase: null,
      payload: { message: "second" },
      createdAt: "2026-06-01T10:00:01.000Z",
    });
    expect(firstId).toBeGreaterThan(0);
    expect(secondId).toBeGreaterThan(firstId);

    const events = getEvents("ev-1");
    expect(events).toHaveLength(2);
    expect(events[0]?.payload).toEqual({ message: "first" });
    expect(events[1]?.payload).toEqual({ message: "second" });
  });

  test("getEvents with afterId returns only newer events", () => {
    insertMigration(makeMigration({ id: "ev-2" }));
    const firstId = insertEvent({
      migrationId: "ev-2",
      eventType: "milestone",
      phase: null,
      payload: { message: "a" },
      createdAt: "2026-06-01T10:00:00.000Z",
    });
    insertEvent({
      migrationId: "ev-2",
      eventType: "milestone",
      phase: null,
      payload: { message: "b" },
      createdAt: "2026-06-01T10:00:01.000Z",
    });
    const after = getEvents("ev-2", firstId);
    expect(after).toHaveLength(1);
    expect(after[0]?.payload).toEqual({ message: "b" });
  });
});

describe("getMigrationStats aggregation", () => {
  beforeEach(() => {
    // A: succeeded, GHEC, 120s, 2 warnings, counts.
    insertMigration(
      makeMigration({
        id: "s-a",
        sourceApiUrl: "https://api.github.com",
        sourceOrg: "octo",
        state: "succeeded",
        targetCounts: counts({ commits: 100, issues: 10 }),
      }),
    );
    updateMigrationState("s-a", "succeeded", {
      elapsedSeconds: 120,
      completedAt: "2026-06-01T10:00:00.000Z",
      warningsCount: 2,
    });

    // B: succeeded, GHES, 60s, counts.
    insertMigration(
      makeMigration({
        id: "s-b",
        sourceApiUrl: "https://ghes.example.com/api/v3",
        sourceOrg: "octo",
        state: "succeeded",
        targetCounts: counts({ commits: 50, issues: 5 }),
      }),
    );
    updateMigrationState("s-b", "succeeded", {
      elapsedSeconds: 60,
      completedAt: "2026-06-01T11:00:00.000Z",
    });

    // C: failed, GHEC, with a reason.
    insertMigration(
      makeMigration({ id: "s-c", sourceApiUrl: "https://api.github.com", state: "failed" }),
    );
    updateMigrationState("s-c", "failed", {
      failureReason: "Archive upload failed",
      completedAt: "2026-06-01T12:00:00.000Z",
    });

    // D: cancelled, GHES. E: running, GHEC.
    insertMigration(
      makeMigration({
        id: "s-d",
        sourceApiUrl: "https://ghes.example.com/api/v3",
        state: "cancelled",
      }),
    );
    insertMigration(
      makeMigration({ id: "s-e", sourceApiUrl: "https://api.github.com", state: "running" }),
    );
  });

  test("totals, byState, and finished", () => {
    const stats = getMigrationStats();
    expect(stats.total).toBe(5);
    expect(stats.byState.succeeded).toBe(2);
    expect(stats.byState.failed).toBe(1);
    expect(stats.byState.cancelled).toBe(1);
    expect(stats.byState.running).toBe(1);
    expect(stats.finished).toBe(4);
  });

  test("successRate is succeeded / finished as a percentage", () => {
    // 2 succeeded of 4 finished = 50.0
    expect(getMigrationStats().successRate).toBe(50);
  });

  test("platform split is derived from the source API URL", () => {
    const { platforms } = getMigrationStats();
    expect(platforms.ghec).toBe(3); // A, C, E
    expect(platforms.ghes).toBe(2); // B, D
  });

  test("resource totals sum target_counts across succeeded migrations only", () => {
    const { resources } = getMigrationStats();
    expect(resources.commits).toBe(150);
    expect(resources.issues).toBe(15);
  });

  test("duration aggregates cover succeeded migrations with elapsed time", () => {
    const { duration } = getMigrationStats();
    expect(duration.totalSeconds).toBe(180);
    expect(duration.minSeconds).toBe(60);
    expect(duration.maxSeconds).toBe(120);
    expect(duration.avgSeconds).toBe(90);
  });

  test("warnings and failure reasons are aggregated", () => {
    const stats = getMigrationStats();
    expect(stats.warnings.total).toBe(2);
    expect(stats.warnings.withWarnings).toBe(1);
    expect(stats.failuresByReason).toEqual([{ reason: "Archive upload failed", count: 1 }]);
  });
});
