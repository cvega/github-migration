import { isAbsolute } from "node:path";
import type { Migration } from "$lib/migrate/types";
import {
  getGhesImportJob,
  insertGhesImportJob,
  updateGhesImportJobCheckpoint,
} from "../database/import-jobs";
import type { GhesImportJob } from "../ghes/job";

export type ExporterSourceProvider = "gitlab" | "bitbucket-server";

export interface ExporterArchiveRequest {
  migrationId: string;
  sourceProvider: ExporterSourceProvider;
  sourceApiUrl: string;
  sourceOrg: string;
  sourceRepo: string;
  lockSource: boolean;
}

interface ExporterArchive {
  path: string;
  sha256: string;
}

export type ExporterJobStatus =
  | { jobId: string; state: "queued" | "running" }
  | { jobId: string; state: "succeeded"; archive: ExporterArchive }
  | { jobId: string; state: "failed" | "cancelled"; failureReason: string };

export const exporterFailures = {
  unstarted: "Exporter container was never started",
  stopped: "Exporter container stopped unexpectedly",
  exit: "Exporter container exited unsuccessfully",
  archive: "Exporter archive is not a regular file",
} as const;

// Both provider replies and older checkpoint rows can contain arbitrary diagnostics.
export function exporterFailureReason(reason: string | null): string {
  return Object.values(exporterFailures).find((known) => known === reason) ?? "Exporter job failed";
}

export interface ExporterWorker {
  identify?(request: ExporterArchiveRequest): string;
  submit(request: ExporterArchiveRequest, signal?: AbortSignal): Promise<{ jobId: string }>;
  inspect(jobId: string, signal?: AbortSignal): Promise<ExporterJobStatus>;
  cancel(jobId: string, signal?: AbortSignal): Promise<void>;
  cleanup?(jobId: string): Promise<void>;
}

function requirePersistedJob(id: string): GhesImportJob {
  const job = getGhesImportJob(id);
  if (!job) throw new Error(`GHES import job '${id}' was not persisted`);
  return job;
}

function assertExporterMigration(
  migration: Migration,
): asserts migration is Migration & { sourceProvider: ExporterSourceProvider } {
  if (migration.targetPlatform !== "ghes") {
    throw new TypeError("Exporter archives are only used for GHES targets");
  }
  if (migration.sourceProvider !== "gitlab" && migration.sourceProvider !== "bitbucket-server") {
    throw new TypeError("Only GitLab and Bitbucket can use an exporter worker");
  }
}

function assertJobId(jobId: string): void {
  if (!jobId.trim() || jobId.length > 255 || /[\p{Cc}]/u.test(jobId)) {
    throw new Error("Exporter returned an invalid job ID");
  }
}

function assertArchive(archive: ExporterArchive): void {
  if (!isAbsolute(archive.path)) throw new Error("Exporter archive path must be absolute");
  if (!/^[a-f0-9]{64}$/i.test(archive.sha256)) {
    throw new Error("Exporter archive SHA-256 is invalid");
  }
}

export async function submitExporterArchive(
  migration: Migration,
  worker: ExporterWorker,
  signal?: AbortSignal,
  sourceWasArchived = false,
): Promise<GhesImportJob> {
  assertExporterMigration(migration);
  const now = new Date().toISOString();
  const jobId = Bun.randomUUIDv7();
  insertGhesImportJob({
    id: jobId,
    migrationId: migration.id,
    phase: "pending",
    exporterJobId: null,
    archivePath: null,
    archiveSha256: null,
    ghesImportId: null,
    sourceWasArchived,
    failureReason: null,
    createdAt: now,
    updatedAt: now,
  });
  const request = {
    migrationId: migration.id,
    sourceProvider: migration.sourceProvider,
    sourceApiUrl: migration.sourceApiUrl,
    sourceOrg: migration.sourceOrg,
    sourceRepo: migration.sourceRepo,
    lockSource: !sourceWasArchived,
  };
  const expectedJobId = worker.identify?.(request);
  if (expectedJobId) assertJobId(expectedJobId);
  updateGhesImportJobCheckpoint(jobId, "exporting", { exporterJobId: expectedJobId });

  const submission = await worker.submit(request, signal);
  assertJobId(submission.jobId);
  if (expectedJobId && submission.jobId !== expectedJobId) {
    throw new Error("Exporter submitted a different job than the durable identifier");
  }
  updateGhesImportJobCheckpoint(jobId, "exporting", { exporterJobId: submission.jobId });
  return requirePersistedJob(jobId);
}

export async function refreshExporterArchive(
  job: GhesImportJob,
  worker: ExporterWorker,
  signal?: AbortSignal,
): Promise<GhesImportJob> {
  if (!job.exporterJobId) throw new Error("Exporter job ID is missing");
  const status = await worker.inspect(job.exporterJobId, signal);
  if (status.jobId !== job.exporterJobId) {
    throw new Error("Exporter returned a status for a different job");
  }
  if (status.state === "succeeded") {
    assertArchive(status.archive);
    updateGhesImportJobCheckpoint(job.id, "archive_ready", {
      archivePath: status.archive.path,
      archiveSha256: status.archive.sha256.toLowerCase(),
    });
  } else if (status.state === "failed" || status.state === "cancelled") {
    updateGhesImportJobCheckpoint(job.id, status.state, {
      failureReason:
        status.state === "cancelled"
          ? "Exporter job cancelled"
          : exporterFailureReason(status.failureReason),
    });
  } else {
    updateGhesImportJobCheckpoint(job.id, "exporting");
  }
  return requirePersistedJob(job.id);
}
