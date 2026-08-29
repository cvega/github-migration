import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Migration } from "$lib/migrate/types";
import { closeStore, initStore } from "$lib/server/core/db";
import type { GhesImportJob, GhesImportJobPhase } from "../ghes/job";
import {
  deleteGhesImportJob,
  getGhesImportJob,
  getGhesImportJobByMigrationId,
  getRecoverableGhesImportJobs,
  insertGhesImportJob,
  updateGhesImportJobCheckpoint,
} from "./import-jobs";
import { insertMigration } from "./migrations";
import { migrateStore } from "./schema";

beforeEach(() => initStore(":memory:", [migrateStore]));
afterEach(closeStore);

function insertOwner(id: string): void {
  const migration: Migration = {
    id,
    batchId: null,
    githubMigrationId: null,
    sourceProvider: "gitlab",
    sourceApiUrl: "https://gitlab.example.com/api/v4",
    targetProfileId: "ghes",
    targetPlatform: "ghes",
    targetApiUrl: "https://ghes.example.com/api/v3",
    sourceOrg: "platform",
    sourceRepo: "api",
    targetOrg: "platform",
    targetRepo: "api",
    state: "running",
    failureReason: null,
    migrationLogUrl: null,
    warningsCount: 0,
    sourceCounts: null,
    targetCounts: null,
    sourceSizeKb: null,
    startedAt: "2026-08-17T12:00:00.000Z",
    completedAt: null,
    elapsedSeconds: null,
    authMode: "env-pat",
    requestOptions: "{}",
  };
  insertMigration(migration);
}

function job(id: string, phase: GhesImportJobPhase = "pending"): GhesImportJob {
  insertOwner(`migration-${id}`);
  return {
    id,
    migrationId: `migration-${id}`,
    phase,
    exporterJobId: null,
    archivePath: null,
    archiveSha256: null,
    ghesImportId: null,
    sourceWasArchived: null,
    failureReason: null,
    createdAt: `2026-08-17T12:00:0${id.length}.000Z`,
    updatedAt: `2026-08-17T12:00:0${id.length}.000Z`,
  };
}

describe("GHES import job persistence", () => {
  test("round-trips jobs and looks them up by migration", () => {
    const record = job("job");
    insertGhesImportJob(record);
    expect(getGhesImportJob(record.id)).toEqual(record);
    expect(getGhesImportJobByMigrationId(record.migrationId)).toEqual(record);
  });

  test("accumulates durable checkpoint fields", () => {
    insertGhesImportJob(job("checkpoint"));
    expect(
      updateGhesImportJobCheckpoint(
        "checkpoint",
        "archive_ready",
        { exporterJobId: "17", archivePath: "/tmp/archive.tar.gz", sourceWasArchived: false },
        "2026-08-17T12:05:00.000Z",
      ),
    ).toBe(true);
    expect(getGhesImportJob("checkpoint")).toMatchObject({
      phase: "archive_ready",
      exporterJobId: "17",
      archivePath: "/tmp/archive.tar.gz",
      sourceWasArchived: false,
      updatedAt: "2026-08-17T12:05:00.000Z",
    });
  });

  test("excludes all terminal and reconciliation phases from recovery", () => {
    for (const phase of [
      "exporting",
      "succeeded",
      "failed",
      "cancelled",
      "reconciliation_required",
    ] as const) {
      const record = job(phase, phase);
      insertGhesImportJob(record);
    }
    expect(getRecoverableGhesImportJobs().map(({ id }) => id)).toEqual(["exporting"]);
  });

  test("deletes jobs exactly once", () => {
    insertGhesImportJob(job("delete"));
    expect(deleteGhesImportJob("delete")).toBe(true);
    expect(deleteGhesImportJob("delete")).toBe(false);
  });
});
