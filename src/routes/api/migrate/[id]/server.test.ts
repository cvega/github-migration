import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Migration } from "$lib/migrate/types";
import { closeStore, initStore } from "$lib/server/core/db";
import { insertMigration } from "$lib/server/migrate/database/migrations";
import { migrateStore } from "$lib/server/migrate/database/schema";
import { DELETE, GET } from "./+server";
import { POST as confirmRestart } from "./confirm-restart/+server";

function migration(id: string, state: Migration["state"]): Migration {
  return {
    id,
    batchId: null,
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

beforeEach(() => initStore(":memory:", [migrateStore]));
afterEach(closeStore);

describe("migration item endpoint", () => {
  test("reads and cancels queued work", async () => {
    insertMigration(migration("queued", "queued"));
    const detail = await GET({ params: { id: "queued" } } as never);
    expect((await detail.json()).state).toBe("queued");
    const cancelled = await DELETE({ params: { id: "queued" } } as never);
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toEqual({ status: "cancelled" });
  });

  test("maps exact confirm-restart attestation to a failed restartable row", async () => {
    insertMigration(migration("ambiguous", "reconciliation_required"));
    const response = await confirmRestart({
      params: { id: "ambiguous" },
      request: new Request("http://localhost/api/migrate/ambiguous/confirm-restart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation: "target/ambiguous" }),
      }),
    } as never);
    expect(response.status).toBe(200);
    expect((await response.json()).state).toBe("failed");
  });
});
