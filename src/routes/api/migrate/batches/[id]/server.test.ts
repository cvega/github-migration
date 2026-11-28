import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Migration } from "$lib/migrate/types";
import { closeStore, getDb, initStore } from "$lib/server/core/db";
import { getMigration, insertMigration } from "$lib/server/migrate/database/migrations";
import { migrateStore } from "$lib/server/migrate/database/schema";
import { DELETE, GET } from "./+server";

function migration(id: string, state: Migration["state"]): Migration {
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
    state,
    failureReason: null,
    migrationLogUrl: null,
    warningsCount: 0,
    sourceCounts: null,
    targetCounts: null,
    sourceSizeKb: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    elapsedSeconds: null,
    authMode: "env-pat",
    requestOptions: "{}",
  };
}

function request(id: string, query = "") {
  const url = new URL(`http://localhost/api/migrate/batches/${id}${query}`);
  return { params: { id }, url } as never;
}

beforeEach(() => initStore(":memory:", [migrateStore]));
afterEach(closeStore);

describe("batch endpoint", () => {
  test("reads a paginated batch and maps missing batches to 404", async () => {
    insertMigration(migration("one", "succeeded"));
    insertMigration(migration("two", "failed"));
    const response = await GET(request("batch-one", "?page=1&limit=1"));
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result.summary.totalCount).toBe(2);
    expect(result.migrations.data).toHaveLength(1);
    expect(result.migrations.total).toBe(2);
    expect((await GET(request("missing"))).status).toBe(404);
  });

  test("reports unreadable cancellation candidates before cancelling siblings", async () => {
    insertMigration(migration("a", "queued"));
    insertMigration(migration("b", "queued"));
    getDb().run("UPDATE migrations SET target_platform='damaged' WHERE id='b'");
    const response = await DELETE(request("batch-one"));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("b");
    expect(getMigration("a")?.state).toBe("queued");
  });

  test("counts durable members and omits unreadable rows from their assigned page", async () => {
    for (const id of ["a", "b", "c"]) insertMigration(migration(id, "succeeded"));
    getDb().run("UPDATE migrations SET warnings_count='unreadable' WHERE id='a'");
    const first = await (await GET(request("batch-one", "?page=1&limit=1"))).json();
    expect(first.migrations).toMatchObject({ total: 3, totalPages: 3, data: [] });
    const second = await (await GET(request("batch-one", "?page=2&limit=1"))).json();
    expect(second.migrations).toMatchObject({ total: 3, totalPages: 3, data: [{ id: "b" }] });
  });

  test("cancels queued batch migrations", async () => {
    insertMigration(migration("queued", "queued"));
    const response = await DELETE(request("batch-one"));

    expect(await response.json()).toEqual({ cancelledCount: 1 });
    expect(getMigration("queued")?.state).toBe("cancelled");
    expect((await DELETE(request("missing"))).status).toBe(404);
  });
});
