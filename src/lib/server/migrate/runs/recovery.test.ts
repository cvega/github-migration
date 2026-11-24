import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Migration } from "$lib/migrate/types";
import { closeStore, getDb, initStore } from "$lib/server/core/db";
import { getMigration, getRecoverableMigrations, insertMigration } from "../database/migrations";
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
  test.each(["gitlab", "bitbucket-server"] as const)(
    "%s never resumes a source export after the target accepted but the worker lost the ID",
    (provider) => {
      closeStore();
      const directory = mkdtempSync(join(tmpdir(), "accepted-import-"));
      const database = join(directory, "jobs.db");
      const ledger = join(directory, "accepted");
      const id = `${provider}-job`;
      try {
        initStore(database, [migrateStore]);
        insertMigration({
          ...migration(id, "running"),
          githubMigrationId: null,
          sourceProvider: provider,
          sourceApiUrl:
            provider === "gitlab"
              ? "https://gitlab.example/api/v4"
              : "https://bbs.example/rest/api/1.0",
          requestOptions: "{}",
        });
        getDb()
          .prepare(
            "UPDATE migrations SET pipeline_step='archive_upload', source_export_id=? WHERE id=?",
          )
          .run(provider === "gitlab" ? "gitlab" : "42", id);
        closeStore();
        const fixture = fileURLToPath(
          new URL("../../../../../tests/fixtures/crash-at-import.ts", import.meta.url),
        );
        const worker = Bun.spawnSync([process.execPath, fixture, database, ledger, id]);
        expect(worker.signalCode).toBe("SIGKILL");
        initStore(database, []);
        expect(
          getDb().query("SELECT pipeline_step, github_migration_id FROM migrations").get(),
        ).toEqual({ pipeline_step: "ghec_starting", github_migration_id: null });
        expect(getRecoverableMigrations()).toHaveLength(0);
        recoverMigrationRuns({
          validateScope: () => null,
          launchRecoveredPipeline: () => {
            throw new Error("A second submission was scheduled");
          },
          drainQueue: () => {},
        });
        expect(getMigration(id)?.state).toBe("reconciliation_required");
        expect(readFileSync(ledger, "utf8")).toBe(`${id}\n`);
      } finally {
        closeStore();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
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
