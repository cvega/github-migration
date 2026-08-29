import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Migration } from "$lib/migrate/types";
import { closeStore, initStore } from "$lib/server/core/db";
import { insertMigration } from "$lib/server/migrate/database/migrations";
import { migrateStore } from "$lib/server/migrate/database/schema";
import { POST } from "./+server";

function uncertainMigration(): Migration {
  return {
    id: "uncertain",
    batchId: null,
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
    state: "reconciliation_required",
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

function request(confirmation: string) {
  return {
    params: { id: "uncertain" },
    request: new Request("http://localhost/api/migrate/uncertain/confirm-restart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation }),
    }),
  } as never;
}

beforeEach(() => {
  initStore(":memory:", [migrateStore]);
  insertMigration(uncertainMigration());
});
afterEach(closeStore);

describe("confirm restart endpoint", () => {
  test("requires the exact target repository attestation", async () => {
    const rejected = await POST(request("target/other"));
    expect(rejected.status).toBe(409);

    const confirmed = await POST(request("target/repository"));
    expect(confirmed.status).toBe(200);
    expect((await confirmed.json()).state).toBe("failed");
  });
});
