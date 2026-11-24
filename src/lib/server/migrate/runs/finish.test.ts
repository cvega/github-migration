import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Migration, MigrationState } from "$lib/migrate/types";
import { closeStore, initStore } from "$lib/server/core/db";
import { getEvents } from "../database/events";
import { getMigration, insertMigration, updateMigrationState } from "../database/migrations";
import { migrateStore } from "../database/schema";
import { activeMigrationRuns } from "./active";
import { createMigrationRunFinisher } from "./finish";

beforeEach(() => initStore(":memory:", [migrateStore]));
afterEach(closeStore);

function migration(id: string, state: MigrationState = "pending"): Migration {
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
    startedAt: "2026-08-18T12:00:00.000Z",
    completedAt: null,
    elapsedSeconds: null,
    authMode: null,
    requestOptions: null,
  };
}

function claimedRun(id: string) {
  const registration = activeMigrationRuns.claim(id);
  if (!registration) throw new Error("run was not claimed");
  activeMigrationRuns.attach(id, registration.token, Promise.resolve());
  return registration;
}

describe("migration run settlement", () => {
  test("persists a terminal result, releases ownership, and drains the queue", () => {
    insertMigration(migration("migration-1"));
    const registration = claimedRun("migration-1");
    let drains = 0;
    createMigrationRunFinisher(() => {
      drains += 1;
    }).settleResult("migration-1", registration.token, {
      ...migration("migration-1", "succeeded"),
      completedAt: "2026-08-18T12:05:00.000Z",
      elapsedSeconds: 300,
    });

    expect(getMigration("migration-1")).toMatchObject({ state: "succeeded", elapsedSeconds: 300 });
    expect(activeMigrationRuns.isActive("migration-1")).toBe(false);
    expect(drains).toBe(1);
  });

  test("preserves an event-persisted terminal state", () => {
    insertMigration(migration("migration-1"));
    const registration = claimedRun("migration-1");
    updateMigrationState("migration-1", "succeeded");
    createMigrationRunFinisher(() => {}).settleResult("migration-1", registration.token, {
      ...migration("migration-1", "failed"),
      targetCounts: { commits: 10, branches: 1, tags: 1, issues: 2, pullRequests: 3, releases: 1 },
    });
    expect(getMigration("migration-1")?.state).toBe("succeeded");
    expect(getMigration("migration-1")?.targetCounts).toBeNull();
  });

  test("persists a later successful final-count lookup after a terminal event", () => {
    insertMigration(migration("migration-1"));
    const registration = claimedRun("migration-1");
    updateMigrationState("migration-1", "succeeded", { targetCounts: null });
    const counts = { commits: 10, branches: 1, tags: 1, issues: 2, pullRequests: 3, releases: 1 };
    createMigrationRunFinisher(() => {}).settleResult("migration-1", registration.token, {
      ...migration("migration-1", "succeeded"),
      targetCounts: counts,
    });
    expect(getMigration("migration-1")?.targetCounts).toEqual(counts);
  });

  test("requires reconciliation for a non-cancelled result while cancellation is pending", () => {
    insertMigration(migration("migration-1", "cancelling"));
    const registration = claimedRun("migration-1");
    createMigrationRunFinisher(() => {}).settleResult(
      "migration-1",
      registration.token,
      migration("migration-1", "succeeded"),
    );
    expect(getMigration("migration-1")).toMatchObject({
      state: "reconciliation_required",
      failureReason: "Migration settled remotely while cancellation was pending",
    });
    expect(getEvents("migration-1").at(-1)?.payload).toEqual({
      message: "Remote migration status requires review before restart",
    });
  });

  test("marks a crashed run failed and ignores stale settlement", () => {
    using consoleError = spyOn(console, "error");
    consoleError.mockImplementation(() => {});
    insertMigration(migration("migration-1"));
    const registration = claimedRun("migration-1");
    const finisher = createMigrationRunFinisher(() => {});
    const error = Object.assign(new Error("private-fixture"), {
      request: { variables: { githubPat: "private-fixture" } },
    });
    finisher.settleError("migration-1", registration.token, error);
    expect(getMigration("migration-1")).toMatchObject({
      state: "failed",
      failureReason: expect.stringContaining("Unexpected executor failure"),
    });
    expect(consoleError.mock.calls.flat()).not.toContain(error);
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("private-fixture");
    expect(JSON.stringify(getEvents("migration-1"))).not.toContain("private-fixture");
    finisher.settleResult("migration-1", registration.token, migration("migration-1", "succeeded"));
    expect(getMigration("migration-1")?.state).toBe("failed");
  });
});
