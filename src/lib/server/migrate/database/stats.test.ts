import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Counts, Migration, MigrationState } from "$lib/migrate/types";
import { closeStore, getDb, initStore } from "$lib/server/core/db";
import { insertMigration, updateMigrationSourceSize, updateMigrationState } from "./migrations";
import { migrateStore } from "./schema";
import {
  getActiveMigrationCount,
  getMigrationCount,
  getMigrationStats,
  getStateCounts,
} from "./stats";

beforeEach(() => initStore(":memory:", [migrateStore]));
afterEach(closeStore);

const resources: Counts = {
  commits: 10,
  branches: 2,
  tags: 1,
  issues: 4,
  pullRequests: 3,
  releases: 1,
};

function migration(
  id: string,
  state: MigrationState = "pending",
  overrides: Partial<Migration> = {},
): Migration {
  return {
    id,
    batchId: null,
    githubMigrationId: null,
    sourceProvider: "github",
    sourceApiUrl: "https://api.github.com",
    targetProfileId: "ghec",
    targetPlatform: "ghec",
    targetApiUrl: "https://api.github.com",
    sourceOrg: "acme",
    sourceRepo: id,
    targetOrg: "acme-cloud",
    targetRepo: id,
    state,
    failureReason: null,
    migrationLogUrl: null,
    warningsCount: 0,
    sourceCounts: null,
    targetCounts: null,
    sourceSizeKb: null,
    startedAt: "2026-08-17T12:00:00.000Z",
    completedAt: null,
    elapsedSeconds: null,
    authMode: null,
    requestOptions: null,
    ...overrides,
  };
}

function insertOutcome(id: string, state: "succeeded" | "failed", elapsedSeconds: number): void {
  insertMigration(migration(id));
  updateMigrationState(id, state, {
    completedAt: "2026-08-17T13:00:00.000Z",
    elapsedSeconds,
    targetCounts: state === "succeeded" ? resources : undefined,
    failureReason: state === "failed" ? "archive failed" : undefined,
    warningsCount: state === "succeeded" ? 2 : 0,
  });
}

describe("migration statistics", () => {
  test("groups archive write failures across runs and links to the latest matching trace", () => {
    for (const [id, day] of [
      ["new", "20"],
      ["old", "19"],
    ] as const) {
      insertMigration(
        migration(id, "pending", {
          sourceProvider: "bitbucket-server",
          sourceApiUrl: "https://bitbucket.example.com/rest/api/1.0",
          targetPlatform: "ghes",
        }),
      );
      updateMigrationState(id, "failed", {
        failureReason: `Bundler will use /tmp/${id}\nPermission denied @ rb_sysopen - /workspace/${id}.tar.gz (Errno::EACCES)\nfrom archiver.rb`,
        completedAt: `2026-11-${day}T00:00:00Z`,
        elapsedSeconds: 6,
      });
    }
    expect(getMigrationStats().failuresByReason).toEqual([
      {
        reason: "Bitbucket exporter could not write the migration archive",
        latestMigrationId: "new",
        latestRunAt: "2026-11-20T00:00:00Z",
        count: 2,
        share: 100,
        avgSeconds: 6,
        totalSeconds: 12,
        timedCount: 2,
      },
    ]);
  });
  test("counts every durable state and only slot-consuming active work", () => {
    for (const state of [
      "queued",
      "pending",
      "running",
      "cancelling",
      "succeeded",
      "failed",
      "cancelled",
      "reconciliation_required",
    ] as const) {
      insertMigration(migration(state, state));
    }
    expect(getStateCounts()).toEqual({
      queued: 1,
      pending: 1,
      running: 1,
      cancelling: 1,
      succeeded: 1,
      failed: 1,
      cancelled: 1,
      reconciliation_required: 1,
    });
    expect(getActiveMigrationCount()).toBe(3);
    expect(getMigrationCount()).toBe(8);
  });

  test("separates reconciliation from outcomes and computes duration and resource totals", () => {
    insertOutcome("success-fast", "succeeded", 10);
    insertOutcome("success-slow", "succeeded", 30);
    insertOutcome("failed", "failed", 20);
    insertMigration(migration("cancelled", "cancelled"));
    insertMigration(migration("review", "reconciliation_required"));
    insertMigration(migration("active", "running"));
    updateMigrationSourceSize("success-fast", 100);
    updateMigrationSourceSize("success-slow", 300);

    const stats = getMigrationStats();
    expect(stats).toMatchObject({
      total: 6,
      finished: 4,
      outcomes: 3,
      resolved: 4,
      active: 1,
      needsReview: 1,
      successRate: 66.7,
      cancellationRate: 25,
      duration: { avgSeconds: 20, medianSeconds: 20, p95Seconds: 30, timedCount: 2 },
      data: { totalKb: 400, avgKb: 200, largestKb: 300, sizedCount: 2 },
      resources: {
        commits: 20,
        branches: 4,
        tags: 2,
        issues: 8,
        pullRequests: 6,
        releases: 2,
        migrationCount: 2,
      },
      warnings: { total: 4, withWarnings: 2 },
    });
    expect(stats.failuresByReason[0]).toMatchObject({ reason: "archive failed", count: 1 });
  });

  test("marks batches with review work as needing attention", () => {
    insertMigration(migration("review", "reconciliation_required", { batchId: "batch-1" }));
    insertMigration(migration("success", "succeeded", { batchId: "batch-1" }));
    expect(getMigrationStats().batchStats[0]).toMatchObject({
      id: "batch-1",
      completed: 2,
      needsReview: 1,
      needsAttention: true,
    });
  });

  test("applies period filters against the injected clock", () => {
    insertMigration(migration("recent", "succeeded"));
    insertMigration(migration("old", "succeeded", { startedAt: "2026-06-01T12:00:00.000Z" }));
    expect(
      getMigrationStats(
        { period: "30d", sourceProvider: "all", targetPlatform: "all", mode: "all" },
        new Date("2026-08-18T12:00:00.000Z"),
      ).total,
    ).toBe(1);
  });

  test("fills calendar gaps in daily throughput", () => {
    insertMigration(migration("first"));
    updateMigrationState("first", "succeeded", {
      completedAt: "2026-08-15T13:00:00.000Z",
      elapsedSeconds: 10,
      targetCounts: resources,
    });
    insertMigration(migration("third"));
    updateMigrationState("third", "failed", {
      completedAt: "2026-08-17T13:00:00.000Z",
      elapsedSeconds: 20,
      failureReason: "archive failed",
    });

    expect(getMigrationStats().throughput).toEqual([
      { date: "2026-08-15", endDate: "2026-08-15", succeeded: 1, failed: 0 },
      { date: "2026-08-16", endDate: "2026-08-16", succeeded: 0, failed: 0 },
      { date: "2026-08-17", endDate: "2026-08-17", succeeded: 0, failed: 1 },
    ]);
  });

  test("charts the full selected history in readable intervals without losing outcomes", () => {
    const now = new Date("2026-11-16T12:00:00.000Z");
    const day = 24 * 60 * 60 * 1000;
    for (const [index, daysAgo] of [0, 7, 30, 89, 179, 399].entries()) {
      const timestamp = new Date(now.getTime() - daysAgo * day).toISOString();
      const id = `history-${index}`;
      insertMigration(migration(id, "pending", { startedAt: timestamp }));
      updateMigrationState(id, index % 2 === 0 ? "succeeded" : "failed", {
        completedAt: timestamp,
      });
    }
    const filters = { sourceProvider: "all", targetPlatform: "all", mode: "all" } as const;
    const all = getMigrationStats({ ...filters, period: "all" }, now);
    const ninety = getMigrationStats({ ...filters, period: "90d" }, now);
    const thirty = getMigrationStats({ ...filters, period: "30d" }, now);

    expect(all.throughputIntervalDays).toBe(7);
    expect(all.throughput.length).toBeLessThanOrEqual(210);
    expect(all.throughput[0]?.date).toBe(
      new Date(now.getTime() - 399 * day).toISOString().slice(0, 10),
    );
    expect(all.throughput.at(-1)?.endDate).toBe("2026-11-16");
    expect(
      all.throughput.reduce((total, bucket) => total + bucket.succeeded + bucket.failed, 0),
    ).toBe(6);
    expect(ninety.throughputIntervalDays).toBe(1);
    expect(ninety.throughput).toHaveLength(90);
    expect(ninety.throughput[0]?.date).toBe(
      new Date(now.getTime() - 89 * day).toISOString().slice(0, 10),
    );
    expect(ninety.throughput.at(-1)?.endDate).toBe("2026-11-16");
    expect(
      ninety.throughput.reduce((total, bucket) => total + bucket.succeeded + bucket.failed, 0),
    ).toBe(4);
    expect(thirty.throughputIntervalDays).toBe(1);
    expect(thirty.throughput).toHaveLength(31);
    expect(
      thirty.throughput.reduce((total, bucket) => total + bucket.succeeded + bucket.failed, 0),
    ).toBe(3);
  });

  test("anchors recent windows to today in UTC and excludes future outcomes", () => {
    for (const [id, completedAt] of [
      ["recent", "2026-11-10T00:00:00.000Z"],
      ["previous", "2026-11-09T23:59:59.000Z"],
      ["old", "2026-09-01T00:00:00.000Z"],
      ["future", "2026-11-16T18:00:00.000Z"],
    ] as const) {
      insertMigration(migration(id));
      updateMigrationState(id, "succeeded", { completedAt });
    }
    const now = new Date("2026-11-16T12:00:00.000Z");
    expect(getMigrationStats(undefined, now).recentWindow).toMatchObject({
      endingOn: "2026-11-16",
      completed: 1,
      previousCompleted: 1,
      successRate: 100,
    });
    expect(
      getMigrationStats(undefined, new Date("2027-01-01T00:00:00.000Z")).recentWindow,
    ).toMatchObject({ completed: 0, previousCompleted: 0, successRate: null });
  });

  test("tracks missing information and separates source owners by host", () => {
    insertMigration(migration("failure", "failed", { batchId: "batch", failureReason: null }));
    insertMigration(migration("retry", "failed", { sourceRepo: "failure" }));
    insertMigration(
      migration("other-host", "running", { sourceApiUrl: "https://ghes.example.com/api/v3" }),
    );
    const stats = getMigrationStats();
    expect(stats.failuresWithoutReason).toBe(2);
    expect(stats.batchFailures).toBe(1);
    expect(stats.topOrgs.map(({ host, count }) => ({ host, count }))).toEqual([
      { host: "api.github.com", count: 2 },
      { host: "ghes.example.com", count: 1 },
    ]);
    expect(stats.resources.migrationCount).toBe(0);
    expect(stats.data.sizedCount).toBe(0);
  });

  test("excludes incomplete or invalid final count records", () => {
    insertOutcome("valid", "succeeded", 10);
    insertOutcome("missing-field", "succeeded", 10);
    insertOutcome("invalid", "succeeded", 10);
    getDb()
      .prepare("UPDATE migrations SET target_counts = ? WHERE id = ?")
      .run('{"commits": 4}', "missing-field");
    getDb()
      .prepare("UPDATE migrations SET target_counts = ? WHERE id = ?")
      .run("not json", "invalid");
    expect(getMigrationStats().resources).toMatchObject({ commits: 10, migrationCount: 1 });
  });

  test("does not treat invalid source sizes as measured data", () => {
    insertOutcome("invalid-size", "succeeded", 10);
    getDb().prepare("UPDATE migrations SET source_size_kb = -1 WHERE id = ?").run("invalid-size");
    const stats = getMigrationStats();
    expect(stats.data).toMatchObject({ sizedCount: 0, avgKb: null });
    expect(stats.sizeUnavailableCount).toBe(1);
  });

  test("has no success rate when there are no outcomes", () => {
    insertMigration(migration("running", "running"));
    expect(getMigrationStats().successRate).toBeNull();
  });
});
