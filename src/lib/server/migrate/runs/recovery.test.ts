import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Migration } from "$lib/migrate/types";
import { authStore } from "$lib/server/core/auth/schema";
import { closeStore, getDb, initStore } from "$lib/server/core/db";
import { getEvents } from "../database/events";
import { getGhesImportJob } from "../database/import-jobs";
import {
  getMigration,
  getRecoverableMigrations,
  insertMigration,
  isGhesSlotHeld,
} from "../database/migrations";
import { migrateStore } from "../database/schema";
import { confirmRestart, restart } from "../manager";
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

beforeEach(() => initStore(":memory:", [migrateStore, authStore]));
afterEach(closeStore);

describe("migration recovery", () => {
  test("revalidates stored TLS overrides before resuming queued or checkpointed jobs", () => {
    const sourceApiUrl = "https://source.example/api/v3";
    const priorPolicy = process.env.GH_ALLOW_INSECURE_SOURCE_TLS;
    const priorSource = process.env.GH_SOURCE_API_URL;
    try {
      process.env.GH_SOURCE_API_URL = sourceApiUrl;
      delete process.env.GH_ALLOW_INSECURE_SOURCE_TLS;
      for (const state of ["running", "queued"] as const) {
        insertMigration({
          ...migration(state, state),
          sourceApiUrl,
          requestOptions: JSON.stringify({ noSslVerify: true }),
        });
      }
      for (const state of ["running", "queued"] as const) {
        insertMigration({
          ...migration(`wrong-source-${state}`, state),
          sourceApiUrl: "https://other.example/api/v3",
          requestOptions: JSON.stringify({ noSslVerify: true }),
        });
      }
      recoverMigrationRuns({
        launchRecoveredPipeline: () => {
          throw new Error("Unexpected recovery launch");
        },
        drainQueue: () => {},
      });
      expect(
        getDb()
          .query(
            "SELECT resource_id FROM audit_events WHERE json_extract(metadata, '$.operation')='recovery' AND json_extract(metadata, '$.outcome')='denied' ORDER BY resource_id",
          )
          .all(),
      ).toEqual([{ resource_id: "queued" }, { resource_id: "running" }]);
      for (const state of ["running", "queued"]) {
        expect(getMigration(`wrong-source-${state}`)?.failureReason).toContain(
          "server-configured source",
        );
      }
      expect(getMigration("running")).toMatchObject({
        state: "reconciliation_required",
        githubMigrationId: "remote-id",
        failureReason: expect.stringContaining("GH_ALLOW_INSECURE_SOURCE_TLS"),
      });
      expect(getMigration("queued")).toMatchObject({
        state: "failed",
        failureReason: expect.stringContaining("GH_ALLOW_INSECURE_SOURCE_TLS"),
      });
    } finally {
      if (priorPolicy === undefined) delete process.env.GH_ALLOW_INSECURE_SOURCE_TLS;
      else process.env.GH_ALLOW_INSECURE_SOURCE_TLS = priorPolicy;
      if (priorSource === undefined) delete process.env.GH_SOURCE_API_URL;
      else process.env.GH_SOURCE_API_URL = priorSource;
    }
  });
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
  test("requires review for checkpointed work when the executor is unavailable", () => {
    insertMigration(migration("active", "running"));
    insertMigration(migration("queued", "queued"));
    recoverMigrationRuns({
      hasExecutor: () => false,
      launchRecoveredPipeline: () => {
        throw new Error("Unexpected recovery launch");
      },
      drainQueue: () => {},
    });
    expect(() => restart("active", {})).toThrow(
      'Cannot restart migration in state "reconciliation_required"',
    );
    expect(getMigration("active")).toMatchObject({
      state: "reconciliation_required",
      githubMigrationId: "remote-id",
      failureReason: expect.stringContaining("No executor"),
    });
    expect(getMigration("queued")?.state).toBe("failed");
    expect(confirmRestart("active", "target/active").state).toBe("failed");
  });

  test.each(["importing", "preparing"] as const)(
    "confirms an unsupported route in %s without discarding checkpoints or enabling restart",
    (phase) => {
      const id = "legacy";
      insertMigration({
        ...migration(id, "running"),
        targetProfileId: "enterprise",
        targetPlatform: "ghes",
        targetApiUrl: "https://ghes.example/api/v3",
      });
      getDb()
        .prepare(`INSERT INTO ghes_import_jobs (id, migration_id, phase, ghes_import_id, created_at, updated_at)
        VALUES ('import', ?, ?, ?, '', '')`)
        .run(id, phase, phase === "preparing" ? null : "saved-import");
      const job = getGhesImportJob("import");
      recoverMigrationRuns({
        launchRecoveredPipeline: () => {
          throw new Error("Unexpected recovery launch");
        },
        drainQueue: () => {},
      });
      expect(() => restart(id, {})).toThrow("github cannot migrate to ghes");
      expect(() => confirmRestart(id, "target/wrong")).toThrow("exactly match");
      expect(getMigration(id)?.state).toBe("reconciliation_required");
      expect(isGhesSlotHeld()).toBe(true);
      expect(getEvents(id)).toHaveLength(0);

      expect(confirmRestart(id, "target/legacy").state).toBe("failed");
      expect(isGhesSlotHeld()).toBe(false);
      expect(getEvents(id).at(-1)).toMatchObject({
        eventType: "step",
        payload: { message: expect.stringContaining("execution remains unsupported") },
      });
      expect(() => restart(id, {})).toThrow("github cannot migrate to ghes");
      expect(getMigration(id)?.githubMigrationId).toBe("remote-id");
      expect(getGhesImportJob("import")).toEqual(job);
    },
  );

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
