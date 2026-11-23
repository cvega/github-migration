import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Migration } from "$lib/migrate/types";
import { closeStore, getDb, initStore } from "$lib/server/core/db";
import { getMigration, insertMigration } from "../database/migrations";
import { migrateStore } from "../database/schema";
import { activeMigrationRuns } from "./active";
import { recoverMigrationRuns } from "./recovery";

function migration(id: string, state: Migration["state"]): Migration {
  return {
    id,
    batchId: null,
    githubMigrationId: state === "running" ? "remote-id" : null,
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
    requestOptions:
      state === "queued"
        ? JSON.stringify({ sourceRepo: `source/${id}`, targetOrg: "target" })
        : null,
  };
}

beforeEach(() => initStore(":memory:", [migrateStore]));
afterEach(closeStore);

describe("migration recovery", () => {
  test("fails unstarted paused work but preserves uncertain GHES jobs for review", () => {
    for (const state of ["queued", "running", "cancelling"] as const) {
      insertMigration({
        ...migration(state, state),
        sourceProvider: "gitlab",
        targetProfileId: "enterprise",
      });
    }
    getDb()
      .prepare(`INSERT INTO ghes_import_jobs (id, migration_id, phase, created_at, updated_at)
      VALUES ('job', 'running', 'exporting', '', '')`)
      .run();
    recoverMigrationRuns({
      launchRecoveredPipeline: () => {
        throw new Error("must not resume");
      },
      drainQueue: () => {},
    });
    expect(activeMigrationRuns.takeQueued("queued")).toBeUndefined();
    expect(getMigration("queued")).toMatchObject({
      state: "failed",
      failureReason: expect.stringContaining("paused"),
    });
    for (const id of ["running", "cancelling"]) {
      expect(getMigration(id)).toMatchObject({
        state: "reconciliation_required",
        failureReason: expect.stringContaining("paused"),
      });
    }
    expect(getDb().query("SELECT phase FROM ghes_import_jobs WHERE id = 'job'").get()).toEqual({
      phase: "exporting",
    });
  });
  test("resumes durable work and rebuilds queued env-auth requests", () => {
    insertMigration(migration("active", "running"));
    insertMigration(migration("queued", "queued"));
    const recovered: string[] = [];
    let drained = false;
    recoverMigrationRuns({
      launchRecoveredPipeline: (record) => {
        recovered.push(record.id);
        return true;
      },
      drainQueue: () => {
        drained = true;
      },
      hasExecutor: () => true,
      validateScope: () => null,
    });
    expect(recovered).toEqual(["active"]);
    expect(activeMigrationRuns.takeQueued("queued")).toMatchObject({
      sourceProvider: "github",
      sourceRepo: "source/queued",
      targetOrg: "target",
    });
    expect(drained).toBe(true);
  });

  test("fails queued work whose persisted options are invalid", () => {
    const record = migration("invalid", "queued");
    record.requestOptions = "not json";
    insertMigration(record);
    recoverMigrationRuns({
      launchRecoveredPipeline: () => false,
      drainQueue: () => {},
      hasExecutor: () => true,
      validateScope: () => null,
    });
    expect(getMigration(record.id)).toMatchObject({
      state: "failed",
      failureReason: "Queued migration request options lost (internal error)",
    });
  });
});
