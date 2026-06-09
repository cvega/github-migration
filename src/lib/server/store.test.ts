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
import type { Counts, Migration, MigrationEvent } from "../types";
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
  getRecentActivity,
  getRecoverableMigrations,
  initStore,
  insertEvent,
  insertMigration,
  listMigrationsPaginated,
  resetMigration,
  searchBatchItemsPaginated,
  searchMigrationsPaginated,
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

describe("searchMigrationsPaginated", () => {
  beforeEach(() => {
    insertMigration(
      makeMigration({
        id: "se-1",
        sourceOrg: "acme",
        sourceRepo: "data-lake",
        targetOrg: "acme-cloud",
        targetRepo: "data-lake",
      }),
    );
    insertMigration(
      makeMigration({
        id: "se-2",
        sourceOrg: "acme",
        sourceRepo: "billing",
        targetOrg: "acme-cloud",
        targetRepo: "billing",
      }),
    );
    insertMigration(
      makeMigration({
        id: "se-3",
        sourceOrg: "globex",
        sourceRepo: "frontend",
        targetOrg: "globex-cloud",
        targetRepo: "data-warehouse",
      }),
    );
    insertMigration(
      makeMigration({
        id: "se-4",
        sourceOrg: "initech",
        sourceRepo: "widget",
        targetOrg: "initech-cloud",
        targetRepo: "widget",
        githubMigrationId: "RM_kgDOdatalake",
      }),
    );
    insertMigration(
      makeMigration({
        id: "se-5",
        sourceOrg: "umbrella",
        sourceRepo: "unrelated",
        targetOrg: "umbrella-cloud",
        targetRepo: "unrelated",
      }),
    );
    updateMigrationState("se-5", "failed", { failureReason: "Archive upload failed: 413" });
  });

  test("matches repo names across source and target (case-insensitive)", () => {
    // "data": se-1 (data-lake), se-3 (data-warehouse target), se-4 (…datalake id).
    expect(
      searchMigrationsPaginated({ q: "data", page: 1, limit: 25 })
        .data.map((m) => m.id)
        .sort(),
    ).toEqual(["se-1", "se-3", "se-4"]);
    // The hyphenated literal only matches se-1 (the id "…datalake" has no hyphen).
    expect(
      searchMigrationsPaginated({ q: "DATA-LAKE", page: 1, limit: 25 }).data.map((m) => m.id),
    ).toEqual(["se-1"]);
  });

  test("matches source/target org", () => {
    expect(
      searchMigrationsPaginated({ q: "acme", page: 1, limit: 25 })
        .data.map((m) => m.id)
        .sort(),
    ).toEqual(["se-1", "se-2"]);
  });

  test("matches the GHEC migration ID", () => {
    const result = searchMigrationsPaginated({ q: "RM_kgDOdatalake", page: 1, limit: 25 });
    expect(result.data.map((m) => m.id)).toEqual(["se-4"]);
  });

  test("matches the internal migration ID", () => {
    expect(
      searchMigrationsPaginated({ q: "se-2", page: 1, limit: 25 }).data.map((m) => m.id),
    ).toEqual(["se-2"]);
  });

  test("matches the failure reason text", () => {
    expect(
      searchMigrationsPaginated({ q: "413", page: 1, limit: 25 }).data.map((m) => m.id),
    ).toEqual(["se-5"]);
  });

  test("returns no matches for an absent term", () => {
    const result = searchMigrationsPaginated({ q: "zzz-nope", page: 1, limit: 25 });
    expect(result.total).toBe(0);
    expect(result.data).toHaveLength(0);
  });

  test("treats LIKE wildcards as literal characters", () => {
    // '%' must not act as a wildcard — no repo literally contains it, so 0 hits.
    expect(searchMigrationsPaginated({ q: "%", page: 1, limit: 25 }).total).toBe(0);
  });

  test("paginates results with correct totals", () => {
    // se-1 and se-2 both match "acme" (org). limit 1 → 2 pages.
    const result = searchMigrationsPaginated({ q: "acme", page: 1, limit: 1 });
    expect(result.total).toBe(2);
    expect(result.totalPages).toBe(2);
    expect(result.data).toHaveLength(1);
  });
});

describe("searchBatchItemsPaginated", () => {
  beforeEach(() => {
    // Batch X: contains a matching repo (payments-api) + an unrelated one.
    insertMigration(
      makeMigration({ id: "bx-1", batchId: "X", sourceRepo: "payments-api", state: "succeeded" }),
    );
    insertMigration(
      makeMigration({ id: "bx-2", batchId: "X", sourceRepo: "logging", state: "failed" }),
    );
    // Batch Y: no matching repo.
    insertMigration(makeMigration({ id: "by-1", batchId: "Y", sourceRepo: "frontend" }));
  });

  test("returns only batches containing at least one matching migration", () => {
    const result = searchBatchItemsPaginated({ q: "payments", page: 1, limit: 10 });
    expect(result.data.map((b) => b.id)).toEqual(["X"]);
  });

  test("aggregate counts reflect the whole batch, not just matches", () => {
    const result = searchBatchItemsPaginated({ q: "payments", page: 1, limit: 10 });
    const batch = result.data[0];
    // Batch X has 2 repos total even though only 1 matched "payments".
    expect(batch?.totalCount).toBe(2);
    expect(batch?.succeededCount).toBe(1);
    expect(batch?.failedCount).toBe(1);
  });

  test("returns nothing when no batch contains a match", () => {
    expect(searchBatchItemsPaginated({ q: "nonexistent", page: 1, limit: 10 }).total).toBe(0);
  });
});

describe("getRecentActivity", () => {
  function event(
    migrationId: string,
    eventType: MigrationEvent["eventType"],
    payload: Record<string, unknown>,
    createdAt: string,
  ): void {
    insertEvent({
      migrationId,
      eventType,
      phase: null,
      payload,
      createdAt,
    } as MigrationEvent);
  }

  beforeEach(() => {
    insertMigration(makeMigration({ id: "act-1", sourceOrg: "acme", sourceRepo: "data-lake" }));
    insertMigration(makeMigration({ id: "act-2", sourceOrg: "globex", sourceRepo: "billing" }));
    // Lifecycle events (surfaced) interleaved with noise events (ignored).
    event("act-1", "step", { message: "validating" }, "2026-06-01T10:00:00.000Z");
    event("act-1", "complete", { elapsed: 120 }, "2026-06-01T10:05:00.000Z");
    event("act-2", "snapshot", { progress: null }, "2026-06-01T10:06:00.000Z");
    event("act-2", "failure", { error: "Archive upload failed: 413" }, "2026-06-01T10:07:00.000Z");
    event(
      "act-1",
      "restart",
      { message: "Migration restarted (previously failed)" },
      "2026-06-01T10:08:00.000Z",
    );
    event("act-2", "banner", { message: "Watchdog: auto-restarting" }, "2026-06-01T10:09:00.000Z");
  });

  test("returns only lifecycle events, newest first", () => {
    const activity = getRecentActivity();
    expect(activity.map((a) => a.kind)).toEqual([
      "notice", // banner (newest)
      "restarted", // restart
      "failed", // failure
      "succeeded", // complete
    ]);
  });

  test("excludes step/snapshot/phase noise", () => {
    const kinds = new Set(getRecentActivity().map((a) => a.kind));
    expect(kinds.has("succeeded")).toBe(true);
    // 'step' and 'snapshot' have no corresponding ActivityKind and must be absent.
    expect(getRecentActivity()).toHaveLength(4);
  });

  test("joins the migration's repo identity", () => {
    const byKind = new Map(getRecentActivity().map((a) => [a.kind, a]));
    expect(byKind.get("succeeded")?.repo).toBe("acme/data-lake");
    expect(byKind.get("failed")?.repo).toBe("globex/billing");
  });

  test("derives a summary from the payload", () => {
    const byKind = new Map(getRecentActivity().map((a) => [a.kind, a]));
    expect(byKind.get("failed")?.summary).toBe("Archive upload failed: 413");
    expect(byKind.get("restarted")?.summary).toBe("Migration restarted (previously failed)");
    expect(byKind.get("notice")?.summary).toBe("Watchdog: auto-restarting");
    // 'complete' needs no detail line.
    expect(byKind.get("succeeded")?.summary).toBe("");
  });

  test("respects the limit", () => {
    expect(getRecentActivity(2).map((a) => a.kind)).toEqual(["notice", "restarted"]);
  });

  test("returns an empty array when there is no activity", () => {
    initStore(":memory:");
    insertMigration(makeMigration({ id: "lonely" }));
    expect(getRecentActivity()).toEqual([]);
  });
});
