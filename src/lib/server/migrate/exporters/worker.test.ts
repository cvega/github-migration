import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Migration } from "$lib/migrate/types";
import { closeStore, initStore } from "$lib/server/core/db";
import { getGhesImportJobByMigrationId } from "../database/import-jobs";
import { insertMigration } from "../database/migrations";
import { migrateStore } from "../database/schema";
import { type ExporterWorker, refreshExporterArchive, submitExporterArchive } from "./worker";

const migration = {
  id: "migration-1",
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
  startedAt: new Date().toISOString(),
  warningsCount: 0,
} as Migration;

beforeEach(() => {
  initStore(":memory:", [migrateStore]);
  insertMigration(migration);
});
afterEach(closeStore);

describe("exporter worker checkpoints", () => {
  test("persists a deterministic ID before submission and records a valid archive", async () => {
    const worker: ExporterWorker = {
      identify: () => "exporter-job",
      submit: async () => {
        expect(getGhesImportJobByMigrationId(migration.id)?.exporterJobId).toBe("exporter-job");
        return { jobId: "exporter-job" };
      },
      inspect: async (jobId) => ({
        jobId,
        state: "succeeded",
        archive: { path: "/tmp/archive.tar.gz", sha256: "A".repeat(64) },
      }),
      cancel: async () => {},
    };
    const submitted = await submitExporterArchive(migration, worker);
    const ready = await refreshExporterArchive(submitted, worker);
    expect(ready).toMatchObject({
      phase: "archive_ready",
      exporterJobId: "exporter-job",
      archivePath: "/tmp/archive.tar.gz",
      archiveSha256: "a".repeat(64),
    });
  });

  test("rejects archive paths and checksums that cannot be trusted", async () => {
    const worker: ExporterWorker = {
      submit: async () => ({ jobId: "job" }),
      inspect: async (jobId) => ({
        jobId,
        state: "succeeded",
        archive: { path: "relative.tar.gz", sha256: "invalid" },
      }),
      cancel: async () => {},
    };
    const submitted = await submitExporterArchive(migration, worker);
    await expect(refreshExporterArchive(submitted, worker)).rejects.toThrow(
      "path must be absolute",
    );
  });
});
