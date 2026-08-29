import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Migration } from "$lib/migrate/types";
import { closeStore, initStore } from "$lib/server/core/db";
import {
  getBatchListItem,
  getBatchMigrationsPaginated,
  getBatchSourceProviderValues,
  getBatchSummary,
  getRestartableBatchSourceProviderValues,
  listBatchItemsPaginated,
  searchBatchItemsPaginated,
} from "./batches";
import { insertMigration } from "./migrations";
import { migrateStore } from "./schema";

beforeEach(() => initStore(":memory:", [migrateStore]));
afterEach(closeStore);

function migration(overrides: Partial<Migration>): Migration {
  const id = overrides.id ?? "migration";
  return {
    id,
    batchId: "batch-1",
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
    state: "pending",
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

describe("migration batch persistence", () => {
  test("aggregates every durable state including reconciliation", () => {
    insertMigration(migration({ id: "alpha", state: "succeeded" }));
    insertMigration(migration({ id: "beta", state: "reconciliation_required" }));
    insertMigration(
      migration({
        id: "gamma",
        state: "failed",
        sourceProvider: "gitlab",
        sourceApiUrl: "https://gitlab.example.com/api/v4",
      }),
    );
    expect(getBatchListItem("batch-1")).toMatchObject({
      totalCount: 3,
      succeededCount: 1,
      failedCount: 1,
      reconciliationRequiredCount: 1,
      mixedRoute: true,
    });
  });

  test("returns stable paged members and a full summary", () => {
    insertMigration(migration({ id: "beta", sourceRepo: "beta" }));
    insertMigration(migration({ id: "alpha", sourceRepo: "alpha" }));
    expect(getBatchMigrationsPaginated("batch-1", { page: 1, limit: 1 })).toMatchObject({
      total: 2,
      totalPages: 2,
      data: [{ sourceRepo: "alpha" }],
    });
    expect(getBatchSummary("batch-1")?.migrations.map(({ sourceRepo }) => sourceRepo)).toEqual([
      "alpha",
      "beta",
    ]);
  });

  test("reports all and restartable source providers", () => {
    insertMigration(migration({ id: "github-failed", state: "failed" }));
    insertMigration(
      migration({
        id: "gitlab-running",
        state: "running",
        sourceProvider: "gitlab",
        sourceApiUrl: "https://gitlab.example.com/api/v4",
      }),
    );
    expect(new Set(getBatchSourceProviderValues("batch-1"))).toEqual(new Set(["github", "gitlab"]));
    expect(getRestartableBatchSourceProviderValues("batch-1")).toEqual(["github"]);
  });

  test("paginates batches and searches matching member fields", () => {
    insertMigration(migration({ id: "widget_100%", batchId: "batch-1" }));
    insertMigration(
      migration({ id: "other", batchId: "batch-2", startedAt: "2026-08-17T13:00:00Z" }),
    );
    expect(listBatchItemsPaginated({ page: 1, limit: 1 })).toMatchObject({
      total: 2,
      totalPages: 2,
    });
    expect(searchBatchItemsPaginated({ page: 1, limit: 10, q: "widget_100%" }).data).toMatchObject([
      { id: "batch-1" },
    ]);
  });
});
