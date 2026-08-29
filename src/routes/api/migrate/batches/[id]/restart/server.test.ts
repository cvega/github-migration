import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Migration } from "$lib/migrate/types";
import { closeStore, initStore } from "$lib/server/core/db";
import { insertMigration } from "$lib/server/migrate/database/migrations";
import { migrateStore } from "$lib/server/migrate/database/schema";
import { POST } from "./+server";

function succeededMigration(): Migration {
  return {
    id: "succeeded",
    batchId: "batch-one",
    githubMigrationId: null,
    sourceProvider: "github",
    sourceApiUrl: "https://api.github.com",
    targetProfileId: "ghec",
    targetPlatform: "ghec",
    targetApiUrl: "https://api.github.com",
    sourceOrg: "source",
    sourceRepo: "repository",
    targetOrg: "target",
    targetRepo: "repository",
    state: "succeeded",
    failureReason: null,
    migrationLogUrl: null,
    warningsCount: 0,
    sourceCounts: null,
    targetCounts: null,
    sourceSizeKb: null,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    elapsedSeconds: 1,
    authMode: "env-pat",
    requestOptions: "{}",
  };
}

function request(id: string, body: unknown) {
  return {
    params: { id },
    request: new Request(`http://localhost/api/migrate/batches/${id}/restart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  } as never;
}

beforeEach(() => {
  initStore(":memory:", [migrateStore]);
  insertMigration(succeededMigration());
});
afterEach(closeStore);

describe("batch restart endpoint", () => {
  test("validates payloads and returns a deterministic no-op for a resolved batch", async () => {
    expect((await POST(request("batch-one", { targetRepoVisibility: "secret" }))).status).toBe(400);
    const response = await POST(
      request("batch-one", {
        sourceToken: "source",
        targetToken: "target",
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ restarted: 0, errors: [] });
  });

  test("maps a missing batch to 404 before parsing credentials", async () => {
    expect((await POST(request("missing", {}))).status).toBe(404);
  });
});
