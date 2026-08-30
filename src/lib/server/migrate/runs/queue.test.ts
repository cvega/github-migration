import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { CreateMigrationRequest, Migration, MigrationState } from "$lib/migrate/types";
import { closeStore, initStore } from "$lib/server/core/db";
import { getMigration, insertMigration, updateMigrationState } from "../database/migrations";
import { migrateStore } from "../database/schema";
import { activeMigrationRuns } from "./active";
import { drainMigrationQueue, getCapacityUsage, MAX_CONCURRENT_MIGRATIONS } from "./queue";

beforeEach(() => initStore(":memory:", [migrateStore]));
afterEach(closeStore);

function request(sourceRepo: string): CreateMigrationRequest {
  return { sourceRepo, targetOrg: "acme-cloud", sourceToken: "secret" };
}

function migration(id: string, state: MigrationState): Migration {
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
    startedAt: `2026-08-18T12:00:${id.padStart(2, "0")}.000Z`,
    completedAt: null,
    elapsedSeconds: null,
    authMode: null,
    requestOptions: null,
  };
}

describe("migration queue", () => {
  test("stops cleanly when no queued migration exists", () => {
    let launches = 0;
    drainMigrationQueue(() => {
      launches += 1;
      return true;
    });
    expect(launches).toBe(0);
  });

  test("fails a claimed migration when its secret request is missing", () => {
    using consoleError = spyOn(console, "error");
    consoleError.mockImplementation(() => {});
    insertMigration(migration("01", "queued"));
    drainMigrationQueue(() => true);
    expect(getMigration("01")).toMatchObject({
      state: "failed",
      failureReason: "Queued migration request lost (internal error)",
    });
  });

  test("keeps a slot for a terminal migration whose promise is settling", () => {
    for (let index = 0; index < MAX_CONCURRENT_MIGRATIONS - 1; index += 1) {
      insertMigration(migration(String(index).padStart(2, "0"), "running"));
    }
    insertMigration(migration("settling", "pending"));
    const registration = activeMigrationRuns.claim("settling");
    if (!registration) throw new Error("settling run was not claimed");
    activeMigrationRuns.attach("settling", registration.token, Promise.resolve());
    updateMigrationState("settling", "succeeded");
    insertMigration(migration("queued", "queued"));
    activeMigrationRuns.enqueue("queued", request("acme/queued"));

    try {
      expect(getCapacityUsage()).toBe(MAX_CONCURRENT_MIGRATIONS);
      drainMigrationQueue(() => true);
      expect(getMigration("queued")?.state).toBe("queued");
    } finally {
      activeMigrationRuns.finish("settling", registration.token);
      activeMigrationRuns.dropQueued("queued");
    }
  });

  test("promotes queued migrations in FIFO order up to available capacity", () => {
    for (let index = 0; index < MAX_CONCURRENT_MIGRATIONS - 2; index += 1) {
      insertMigration(migration(String(index).padStart(2, "0"), "running"));
    }
    for (const id of ["10", "11", "12"]) {
      insertMigration(migration(id, "queued"));
      activeMigrationRuns.enqueue(id, request(`acme/${id}`));
    }
    const launched: string[] = [];
    drainMigrationQueue((id) => {
      launched.push(id);
      return true;
    });

    expect(launched).toEqual(["10", "11"]);
    expect(getMigration("10")?.state).toBe("pending");
    expect(getMigration("11")?.state).toBe("pending");
    expect(getMigration("12")?.state).toBe("queued");
    activeMigrationRuns.dropQueued("12");
  });
});
