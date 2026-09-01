import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Counts, Migration, MigrationState } from "$lib/migrate/types";
import { closeStore, initStore } from "$lib/server/core/db";
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
});
