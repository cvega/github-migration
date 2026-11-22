import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Migration } from "$lib/migrate/types";
import { closeStore, initStore } from "$lib/server/core/db";
import { insertMigration } from "$lib/server/migrate/database/migrations";
import { migrateStore } from "$lib/server/migrate/database/schema";
import { load } from "./+page.server";

function migration(id: string): Migration {
  return {
    id,
    batchId: "batch-one",
    githubMigrationId: null,
    sourceProvider: "github",
    sourceApiUrl: "https://api.github.com",
    targetProfileId: "ghec",
    targetPlatform: "ghec",
    targetApiUrl: "https://api.github.com",
    sourceOrg: "source",
    sourceRepo: id,
    targetOrg: "target",
    targetRepo: id,
    state: "succeeded",
    failureReason: null,
    migrationLogUrl: null,
    warningsCount: 0,
    sourceCounts: null,
    targetCounts: null,
    sourceSizeKb: null,
    startedAt: "2026-08-07T12:00:00.000Z",
    completedAt: "2026-08-07T12:01:00.000Z",
    elapsedSeconds: 60,
    authMode: "env-pat",
    requestOptions: "{}",
  };
}

beforeEach(() => initStore(":memory:", [migrateStore]));
afterEach(closeStore);

describe("batch detail loader", () => {
  test("loads a bounded page and restart capability through the manager", async () => {
    insertMigration({ ...migration("one"), state: "failed" });
    insertMigration({
      ...migration("two"),
      state: "cancelled",
      sourceProvider: "gitlab",
      targetPlatform: "ghes",
    });
    const result = await load({
      params: { id: "batch-one" },
      url: new URL("http://localhost/migrate/batches/batch-one?page=0&limit=500"),
    } as never);
    if (!result) throw new Error("Expected batch page data");

    expect(result.batch.totalCount).toBe(2);
    expect(result.migrations.page).toBe(1);
    expect(result.migrations.limit).toBe(100);
    expect(result.restartableCount).toBe(1);
    expect(result.sourceProvider).toBeNull();
  });

  test("returns 404 for a missing batch", () => {
    try {
      load({
        params: { id: "missing" },
        url: new URL("http://localhost/migrate/batches/missing"),
      } as never);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({
        status: 404,
        body: { message: "Batch not found" },
      });
    }
  });
});
