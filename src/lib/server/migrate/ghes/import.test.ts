import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Migration } from "$lib/migrate/types";
import { closeStore, initStore } from "$lib/server/core/db";
import { getGhesImportJobByMigrationId, insertGhesImportJob } from "../database/import-jobs";
import { insertMigration } from "../database/migrations";
import { migrateStore } from "../database/schema";
import type { ExporterWorker } from "../exporters/worker";
import {
  type ExporterGhesSourceAdapter,
  resumeExporterGhesMigration,
  runExporterGhesMigration,
} from "./import";

function migration(id: string): Migration {
  return {
    id,
    batchId: null,
    githubMigrationId: null,
    sourceProvider: "gitlab",
    sourceApiUrl: "https://gitlab.example/api/v4",
    targetProfileId: "ghes",
    targetPlatform: "ghes",
    targetApiUrl: "https://ghes.example/api/v3",
    sourceOrg: "group",
    sourceRepo: "project",
    targetOrg: "target",
    targetRepo: "project",
    state: "running",
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

function adapter(worker: ExporterWorker): ExporterGhesSourceAdapter {
  return {
    provider: "gitlab",
    displayName: "GitLab",
    getConfig: () =>
      ({
        profile: {
          apiUrl: "https://ghes.example/api/v3",
          webUrl: "https://ghes.example",
        },
      }) as never,
    assertSource: () => {},
    createWorker: () => worker,
    createSshClient: () => ({
      connect: async () => {},
      disconnect: () => {},
      remoteArchivePath: () => "/remote/archive.tar.gz",
      uploadArchive: async () => "/remote/archive.tar.gz",
      prepare: async () => "migration-guid-123",
      conflicts: async () => ({ stdout: "", stderr: "" }),
      mappingRecords: async () => ({ stdout: "", stderr: "" }),
      map: async () => ({ stdout: "", stderr: "" }),
      import: async () => ({ stdout: "", stderr: "" }),
      auditFailures: async () => ({ stdout: "", stderr: "" }),
      unlock: async () => ({ stdout: "", stderr: "" }),
      removeArchive: async () => ({ stdout: "", stderr: "" }),
    }),
    sourceWasLocked: async () => true,
    wait: async () => {},
  };
}

beforeEach(() => initStore(":memory:", [migrateStore]));
afterEach(closeStore);

describe("GHES import execution", () => {
  test("checkpoints exporter, transfer, prepare, import, audit, and unlock", async () => {
    const record = migration("ghes-success");
    insertMigration(record);
    const worker: ExporterWorker = {
      submit: async () => ({ jobId: "export-job" }),
      inspect: async (jobId) => ({
        jobId,
        state: "succeeded",
        archive: { path: "/tmp/export.tar.gz", sha256: "a".repeat(64) },
      }),
      cancel: async () => {},
    };
    const result = await runExporterGhesMigration(
      { id: record.id, sourceProvider: "gitlab", emit: () => {} },
      adapter(worker),
    );
    expect(result.state).toBe("succeeded");
    expect(getGhesImportJobByMigrationId(record.id)?.phase).toBe("succeeded");
  });

  test("does not replay an import interrupted at an ambiguous checkpoint", async () => {
    const record = migration("ghes-ambiguous");
    insertMigration(record);
    const now = new Date().toISOString();
    insertGhesImportJob({
      id: "job",
      migrationId: record.id,
      phase: "importing",
      exporterJobId: "export-job",
      archivePath: "/tmp/export.tar.gz",
      archiveSha256: "a".repeat(64),
      ghesImportId: "migration-guid-123",
      sourceWasArchived: true,
      failureReason: null,
      createdAt: now,
      updatedAt: now,
    });
    const worker: ExporterWorker = {
      submit: async () => ({ jobId: "unused" }),
      inspect: async () => ({ jobId: "unused", state: "running" }),
      cancel: async () => {},
    };
    const result = await resumeExporterGhesMigration(record, () => {}, undefined, adapter(worker));
    expect(result.state).toBe("reconciliation_required");
    expect(result.failureReason).toContain("ambiguous ghe-migrator importing");
  });
});
