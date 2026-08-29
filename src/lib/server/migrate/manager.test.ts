import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Migration } from "$lib/migrate/types";
import { closeStore, initStore } from "$lib/server/core/db";
import { getEvents } from "./database/events";
import { getMigration, insertMigration } from "./database/migrations";
import { migrateStore } from "./database/schema";
import { cancel, confirmRestart, MAX_CONCURRENT_MIGRATIONS, start } from "./manager";

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
    authMode: null,
    requestOptions: null,
  };
}

beforeEach(() => initStore(":memory:", [migrateStore]));
afterEach(closeStore);

describe("migration manager", () => {
  test("queues work beyond capacity and cancels it without launching", () => {
    for (let index = 0; index < MAX_CONCURRENT_MIGRATIONS; index += 1) {
      insertMigration(migration(`active-${index}`, "running"));
    }
    const queued = start({
      sourceProvider: "github",
      sourceApiUrl: "https://api.github.com",
      sourceRepo: "source/queued",
      targetOrg: "target",
      sourceToken: "source-token",
      targetToken: "target-token",
    });
    expect(queued.state).toBe("queued");
    expect(queued.requestOptions).not.toContain("source-token");
    expect(cancel(queued.id)).toBe(true);
    expect(getMigration(queued.id)?.state).toBe("cancelled");
  });

  test("requires exact target confirmation before restart eligibility", () => {
    const record = migration("ambiguous", "reconciliation_required");
    insertMigration(record);
    expect(() => confirmRestart(record.id, "target/wrong")).toThrow(
      'Confirmation must exactly match "target/ambiguous"',
    );
    const confirmed = confirmRestart(record.id, "target/ambiguous");
    expect(confirmed.state).toBe("failed");
    expect(getEvents(record.id).at(-1)).toMatchObject({
      eventType: "step",
      payload: { message: expect.stringContaining("eligible for restart") },
    });
  });
});
