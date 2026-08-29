import { rm } from "node:fs/promises";
import type { Migration } from "$lib/migrate/types";
import type { GhesTargetConnectionConfig } from "$lib/server/core/ghes-target";
import { sleep } from "$lib/server/core/polling";
import {
  deleteGhesImportJob,
  getGhesImportJobByMigrationId,
  updateGhesImportJobCheckpoint,
} from "../database/import-jobs";
import { getMigration, updateCheckpoint } from "../database/migrations";
import { emitNativeStep } from "../executors/native-to-ghec";
import {
  type ExporterSourceProvider,
  type ExporterWorker,
  refreshExporterArchive,
  submitExporterArchive,
} from "../exporters/worker";
import type { MigrationEventEmitter } from "../github/monitor";
import { buildGhesMigrationMap, countGhesAuditFailures } from "./mapping";
import type { GhesSshClient } from "./ssh";

const EXPORT_POLL_INTERVAL_MS = 5_000;
class ReconciliationRequiredError extends Error {}

export type GhesImportClient = Pick<
  GhesSshClient,
  | "connect"
  | "disconnect"
  | "remoteArchivePath"
  | "uploadArchive"
  | "prepare"
  | "conflicts"
  | "mappingRecords"
  | "map"
  | "import"
  | "auditFailures"
  | "unlock"
  | "removeArchive"
>;

export interface ExporterGhesSourceAdapter {
  provider: ExporterSourceProvider;
  displayName: string;
  getConfig(profileId?: string): GhesTargetConnectionConfig;
  assertSource(migration: Migration): void;
  createWorker(config: GhesTargetConnectionConfig): ExporterWorker;
  createSshClient(config: GhesTargetConnectionConfig): GhesImportClient;
  sourceWasLocked(migration: Migration, signal?: AbortSignal): Promise<boolean>;
  unlockSource?(migration: Migration): Promise<void>;
  wait(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

export interface GhesMigrationOptions {
  id?: string;
  signal?: AbortSignal;
  emit: MigrationEventEmitter;
  sourceProvider?: Migration["sourceProvider"];
}

function settled(
  migration: Migration,
  state: Migration["state"],
  failureReason: string | null = null,
): Migration {
  return {
    ...migration,
    state,
    failureReason,
    completedAt: new Date().toISOString(),
    elapsedSeconds: Math.max(0, (Date.now() - Date.parse(migration.startedAt)) / 1_000),
  };
}

async function waitForArchive(
  migration: Migration,
  worker: ExporterWorker,
  signal: AbortSignal | undefined,
  emit: MigrationEventEmitter,
  source: ExporterGhesSourceAdapter,
) {
  let job = getGhesImportJobByMigrationId(migration.id);
  if (!job?.exporterJobId) {
    throw new ReconciliationRequiredError("Exporter container identifier is missing");
  }
  while (job.phase === "exporting") {
    signal?.throwIfAborted();
    job = await refreshExporterArchive(job, worker, signal);
    if (job.phase === "failed")
      throw new Error(job.failureReason || `${source.displayName} export failed`);
    if (job.phase === "cancelled") {
      throw new DOMException(`${source.displayName} export cancelled`, "AbortError");
    }
    if (job.phase === "exporting") await source.wait(EXPORT_POLL_INTERVAL_MS, signal);
  }
  if (job.phase !== "archive_ready" || !job.archivePath || !job.archiveSha256) {
    throw new Error(`Unexpected GHES import phase '${job.phase}' after export`);
  }
  const exporterJobId = job.exporterJobId;
  if (!exporterJobId)
    throw new ReconciliationRequiredError("Exporter container identifier is missing");
  emitNativeStep(
    emit,
    migration.id,
    `${source.displayName} archive ready (${job.archiveSha256.slice(0, 12)})`,
  );
  await worker.cleanup?.(exporterJobId).catch(() => {});
  return job;
}

async function execute(
  migration: Migration,
  options: Pick<GhesMigrationOptions, "signal" | "emit">,
  recovering: boolean,
  source: ExporterGhesSourceAdapter,
): Promise<Migration> {
  if (migration.sourceProvider !== source.provider) {
    throw new TypeError(`${source.displayName} GHES source adapter does not match the migration`);
  }
  let worker: ExporterWorker | null = null;
  let ssh: GhesImportClient | null = null;
  let remoteArchivePath: string | null = null;
  let sourceUnlockRequired = false;
  let result: Migration | null = null;
  try {
    const config = source.getConfig(migration.targetProfileId);
    if (config.profile.apiUrl !== migration.targetApiUrl) {
      throw new ReconciliationRequiredError("Configured GHES target URL changed after submission");
    }
    source.assertSource(migration);
    worker = source.createWorker(config);
    let job = getGhesImportJobByMigrationId(migration.id);
    const priorSourceWasLocked = job?.sourceWasArchived ?? null;
    sourceUnlockRequired = Boolean(source.unlockSource && job?.sourceWasArchived === false);

    if (
      job &&
      (job.phase === "pending" ||
        (!recovering && ["failed", "cancelled", "reconciliation_required"].includes(job.phase)))
    ) {
      if (job.exporterJobId) await worker.cleanup?.(job.exporterJobId).catch(() => {});
      if (job.archivePath) await rm(job.archivePath, { force: true }).catch(() => {});
      deleteGhesImportJob(job.id);
      job = null;
    }
    if (!job) {
      updateCheckpoint(migration.id, "source_export", { authMode: "env-pat" });
      const sourceWasLocked =
        priorSourceWasLocked ?? (await source.sourceWasLocked(migration, options.signal));
      sourceUnlockRequired = Boolean(source.unlockSource && !sourceWasLocked);
      emitNativeStep(
        options.emit,
        migration.id,
        `Starting ${source.displayName} export${sourceWasLocked ? "" : " with source lock"}`,
      );
      job = await submitExporterArchive(migration, worker, options.signal, sourceWasLocked);
    }

    if (job.phase === "succeeded") {
      throw new ReconciliationRequiredError(
        "GHES import job already succeeded while the migration remained incomplete",
      );
    }
    if (job.phase === "mapping" || job.phase === "importing") {
      throw new ReconciliationRequiredError(
        `Server restarted during ambiguous ghe-migrator ${job.phase} operation`,
      );
    }
    if (job.phase === "preparing" && !job.ghesImportId) {
      throw new ReconciliationRequiredError(
        "Server restarted before the ghe-migrator prepare outcome was recorded",
      );
    }
    if (job.phase === "exporting") {
      job = await waitForArchive(migration, worker, options.signal, options.emit, source);
    }
    if (!job.archivePath) throw new Error("GHES import archive checkpoint is missing");

    ssh = source.createSshClient(config);
    await ssh.connect(options.signal);
    remoteArchivePath = ssh.remoteArchivePath(job.archivePath);
    if (job.phase === "archive_ready" || job.phase === "transferring") {
      updateGhesImportJobCheckpoint(job.id, "transferring");
      emitNativeStep(options.emit, migration.id, "Transferring archive to GHES with SCP");
      remoteArchivePath = await ssh.uploadArchive(job.archivePath, options.signal);
      updateGhesImportJobCheckpoint(job.id, "preparing");
      emitNativeStep(options.emit, migration.id, "Preparing archive on GHES");
      const guid = await ssh.prepare(remoteArchivePath);
      updateGhesImportJobCheckpoint(job.id, "preparing", { ghesImportId: guid });
      options.signal?.throwIfAborted();
      job = getGhesImportJobByMigrationId(migration.id) as typeof job;
    }

    const guid = job.ghesImportId;
    if (!guid) throw new ReconciliationRequiredError("GHES Migration GUID is missing");
    if (job.phase === "preparing") {
      emitNativeStep(options.emit, migration.id, "Generating and applying GHES mappings");
      const [conflicts, records] = await Promise.all([
        ssh.conflicts(guid),
        ssh.mappingRecords(guid),
      ]);
      options.signal?.throwIfAborted();
      const mapping = buildGhesMigrationMap(
        conflicts.stdout,
        records.stdout,
        config.profile.webUrl,
        migration.targetOrg,
        migration.targetRepo,
      );
      if (mapping) {
        updateGhesImportJobCheckpoint(job.id, "mapping");
        await ssh.map(guid, mapping);
        options.signal?.throwIfAborted();
      }
      updateGhesImportJobCheckpoint(job.id, "importing");
      emitNativeStep(options.emit, migration.id, "Importing archive into GHES");
      await ssh.import(remoteArchivePath, guid);
      updateGhesImportJobCheckpoint(job.id, "auditing");
      options.signal?.throwIfAborted();
      job = getGhesImportJobByMigrationId(migration.id) as typeof job;
    }

    if (job.phase === "auditing") {
      emitNativeStep(options.emit, migration.id, "Auditing failed GHES import records");
      const failures = countGhesAuditFailures((await ssh.auditFailures(guid)).stdout);
      if (failures > 0) throw new Error(`GHES import audit found ${failures} failed record(s)`);
      updateGhesImportJobCheckpoint(job.id, "unlocking");
      job = getGhesImportJobByMigrationId(migration.id) as typeof job;
    }
    if (job.phase === "unlocking") {
      emitNativeStep(options.emit, migration.id, "Unlocking imported GHES repository");
      await ssh.unlock(guid);
    } else {
      throw new ReconciliationRequiredError(
        `GHES import job reached unexpected completion phase '${job.phase}'`,
      );
    }
    updateGhesImportJobCheckpoint(job.id, "succeeded");
    await ssh.removeArchive(remoteArchivePath).catch(() => {});
    const localArchivePath = job.archivePath;
    if (!localArchivePath) throw new Error("GHES import archive checkpoint is missing");
    await rm(localArchivePath, { force: true }).catch(() => {});
    emitNativeStep(options.emit, migration.id, "GHES migration completed");
    result = settled(migration, "succeeded");
  } catch (error) {
    const current = getGhesImportJobByMigrationId(migration.id);
    if (options.signal?.aborted && current?.phase === "exporting" && current.exporterJobId) {
      await worker?.cancel(current.exporterJobId).catch(() => {});
    }
    const ambiguous =
      error instanceof ReconciliationRequiredError ||
      (current !== null &&
        (current.phase === "mapping" ||
          current.phase === "importing" ||
          (current.phase === "preparing" && !current.ghesImportId)));
    const state = ambiguous
      ? "reconciliation_required"
      : options.signal?.aborted
        ? "cancelled"
        : "failed";
    const reason = error instanceof Error ? error.message : String(error);
    if (current) updateGhesImportJobCheckpoint(current.id, state, { failureReason: reason });
    result = settled(migration, state, reason);
  } finally {
    ssh?.disconnect();
    if (
      sourceUnlockRequired &&
      source.unlockSource &&
      result?.state !== "reconciliation_required"
    ) {
      try {
        await source.unlockSource(migration);
      } catch (error) {
        const reason = `${source.displayName} source unlock requires reconciliation: ${error instanceof Error ? error.message : String(error)}`;
        const current = getGhesImportJobByMigrationId(migration.id);
        if (current) {
          updateGhesImportJobCheckpoint(current.id, "reconciliation_required", {
            failureReason: reason,
          });
        }
        result = settled(migration, "reconciliation_required", reason);
      }
    }
  }
  return result ?? settled(migration, "failed", "GHES migration did not settle");
}

export async function runExporterGhesMigration(
  options: GhesMigrationOptions,
  source: ExporterGhesSourceAdapter,
): Promise<Migration> {
  if (options.sourceProvider !== source.provider) {
    throw new TypeError(
      `${source.displayName} GHES executor requires sourceProvider '${source.provider}'`,
    );
  }
  if (!options.id)
    throw new TypeError(`${source.displayName} GHES executor requires a persisted migration ID`);
  const migration = getMigration(options.id);
  if (migration?.targetPlatform !== "ghes" || migration.sourceProvider !== source.provider) {
    throw new TypeError(`Persisted ${source.displayName} GHES migration was not found`);
  }
  return execute(migration, options, false, source);
}

export function resumeExporterGhesMigration(
  migration: Migration,
  emit: MigrationEventEmitter,
  signal: AbortSignal | undefined,
  source: ExporterGhesSourceAdapter,
): Promise<Migration> {
  if (migration.sourceProvider !== source.provider || migration.targetPlatform !== "ghes") {
    throw new TypeError(`Only ${source.displayName}-to-GHES migrations can use this recovery path`);
  }
  return execute(migration, { emit, signal }, true, source);
}

export const defaultGhesWait = sleep;
