import { rm } from "node:fs/promises";
import type { Migration, Phase } from "$lib/migrate/types";
import type { GhesTargetConnectionConfig } from "$lib/server/core/ghes-target";
import { createSingleClient } from "$lib/server/core/github";
import { sleep } from "$lib/server/core/polling";
import { safeErrorReason } from "$lib/server/core/safe-error";
import { discoverIdentityMapping, listIdentityMappings } from "../database/identity-mappings";
import {
  deleteGhesImportJob,
  getGhesImportJobByMigrationId,
  updateGhesImportJobCheckpoint,
} from "../database/import-jobs";
import { getMigration, updateCheckpoint } from "../database/migrations";
import {
  ExporterOwnershipError,
  type ExporterSourceProvider,
  type ExporterWorker,
  exporterFailureReason,
  refreshExporterArchive,
  submitExporterArchive,
} from "../exporters/worker";
import type { MigrationEventEmitter } from "../github/monitor";
import { fetchMigrationTargetCounts, targetCountFailureReason } from "../target-counts";
import type { GhesImportJobPhase } from "./job";
import {
  approvedBitbucketRecords,
  buildGhesMigrationMap,
  countGhesAuditFailures,
  getGhesUserConflicts,
} from "./mapping";
import { GhesMigratorBusyError, type GhesSshClient } from "./ssh";

const EXPORT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_EXPORT_TIMEOUT_MS = 6 * 60 * 60 * 1_000;

function exportTimeoutMs(): number {
  const configured = Number(process.env.GHES_EXPORT_TIMEOUT_MS);
  return Number.isInteger(configured) && configured > 0 && configured <= 2_147_483_647
    ? configured
    : DEFAULT_EXPORT_TIMEOUT_MS;
}

const RECOVERY_INSPECTION_TIMEOUT_MS = 45_000;
const MAX_MAPPING_PASSES = 3;

function emitImportStep(
  emit: MigrationEventEmitter,
  migrationId: string,
  executorPhase: GhesImportJobPhase,
  message: string,
  phase: Phase | null = null,
): void {
  emit({
    migrationId,
    eventType: "step",
    phase,
    payload: { message, executorPhase },
    createdAt: new Date().toISOString(),
  });
}
export class GhesImportDiagnostic extends Error {}
class ExportFailedError extends GhesImportDiagnostic {}
class ReconciliationRequiredError extends GhesImportDiagnostic {}

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
  verifyTargetUser?(config: GhesTargetConnectionConfig, login: string): Promise<void>;
  localMappingRecords?(archivePath: string, signal?: AbortSignal): Promise<string>;
  fetchTargetCounts?: typeof fetchMigrationTargetCounts;
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

function rethrowOwnershipError(error: unknown): void {
  if (error instanceof ExporterOwnershipError) throw error;
}

async function removeFailedExporter(
  worker: ExporterWorker,
  containerId: string,
  migrationId: string,
) {
  try {
    await worker.cleanup?.(containerId, migrationId);
  } catch (error) {
    rethrowOwnershipError(error);
    throw new ReconciliationRequiredError(
      "Local exporter cleanup is unconfirmed. Check the exporter container before confirming a restart.",
    );
  }
}

async function waitForArchive(
  migration: Migration,
  worker: ExporterWorker,
  signal: AbortSignal | undefined,
  emit: MigrationEventEmitter,
  source: ExporterGhesSourceAdapter,
  recovering: boolean,
) {
  let job = getGhesImportJobByMigrationId(migration.id);
  if (!job?.exporterJobId) {
    throw new ReconciliationRequiredError("Exporter container identifier is missing");
  }
  const containerId = job.exporterJobId;
  const remaining = Date.parse(job.createdAt) + exportTimeoutMs() - Date.now();
  const timeout = new AbortController();
  // A completed archive may have been waiting for inspection throughout an outage.
  const inspectExpired = recovering && remaining <= 0;
  const timer = setTimeout(
    () => timeout.abort(),
    inspectExpired ? RECOVERY_INSPECTION_TIMEOUT_MS : Math.max(0, remaining),
  );
  const pollSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  try {
    if (remaining <= 0 && !inspectExpired) timeout.abort();
    while (job.phase === "exporting") {
      pollSignal.throwIfAborted();
      try {
        job = await refreshExporterArchive(job, worker, pollSignal);
      } catch (error) {
        rethrowOwnershipError(error);
        signal?.throwIfAborted();
        if (inspectExpired)
          throw new ReconciliationRequiredError(
            "Expired exporter status is unconfirmed. Check the container and archive before confirming a restart.",
          );
        throw error;
      }
      if (job.phase === "failed") {
        await removeFailedExporter(worker, containerId, migration.id);
        throw new ExportFailedError(
          `${source.displayName} export failed: ${exporterFailureReason(job.failureReason)}`,
        );
      }
      if (job.phase === "cancelled") {
        throw new DOMException(`${source.displayName} export cancelled`, "AbortError");
      }
      if (job.phase === "exporting") {
        if (inspectExpired) {
          timeout.abort();
          pollSignal.throwIfAborted();
        }
        await source.wait(EXPORT_POLL_INTERVAL_MS, pollSignal);
      }
    }
  } catch (error) {
    if (error instanceof ReconciliationRequiredError || error instanceof ExporterOwnershipError)
      throw error;
    signal?.throwIfAborted();
    if (!timeout.signal.aborted) throw error;
    await worker
      .cancel(containerId, migration.id, AbortSignal.timeout(45_000))
      .catch(rethrowOwnershipError);
    await removeFailedExporter(worker, containerId, migration.id);
    throw new ExportFailedError("GHES exporter timed out");
  } finally {
    clearTimeout(timer);
  }
  if (job.phase !== "archive_ready" || !job.archivePath || !job.archiveSha256) {
    throw new Error(`Unexpected GHES import phase '${job.phase}' after export`);
  }
  const exporterJobId = job.exporterJobId;
  if (!exporterJobId)
    throw new ReconciliationRequiredError("Exporter container identifier is missing");
  emitImportStep(
    emit,
    migration.id,
    "archive_ready",
    `${source.displayName} archive ready (${job.archiveSha256.slice(0, 12)})`,
    "EXPORTING",
  );
  await worker.cleanup?.(exporterJobId, migration.id).catch(rethrowOwnershipError);
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

    if (job?.phase === "succeeded") {
      // The target is finished. Only source cleanup may have been interrupted.
      if (sourceUnlockRequired) {
        sourceUnlockRequired = false;
        await source.unlockSource!(migration);
      }
      return await completeGhesMigration(migration, source, options.emit);
    }
    if (
      job?.ghesImportId &&
      ["failed", "cancelled", "reconciliation_required"].includes(job.phase)
    ) {
      throw new ReconciliationRequiredError(
        `Legacy GHES job ${job.ghesImportId} has no reliable import phase; inspect the GUID on GHES. Do not submit another import.`,
      );
    }
    if (
      job &&
      (job.phase === "pending" ||
        (!recovering && ["failed", "cancelled", "reconciliation_required"].includes(job.phase)))
    ) {
      if (job.exporterJobId) await removeFailedExporter(worker, job.exporterJobId, migration.id);
      if (job.archivePath) await rm(job.archivePath, { force: true }).catch(() => {});
      deleteGhesImportJob(job.id);
      job = null;
    }
    if (!job) {
      updateCheckpoint(migration.id, "source_export", { authMode: "env-pat" });
      const sourceWasLocked =
        priorSourceWasLocked ?? (await source.sourceWasLocked(migration, options.signal));
      sourceUnlockRequired = Boolean(source.unlockSource && !sourceWasLocked);
      emitImportStep(
        options.emit,
        migration.id,
        "exporting",
        `Starting ${source.displayName} export${sourceWasLocked ? "" : " with source lock"}`,
        "EXPORTING",
      );
      job = await submitExporterArchive(migration, worker, options.signal, sourceWasLocked);
    }

    if (job.phase === "mapping" && !recovering && job.ghesImportId) {
      // An explicitly authorized restart may re-read conflicts for this GUID, before import.
      updateGhesImportJobCheckpoint(job.id, "preparing");
      job = { ...job, phase: "preparing" };
    }
    if (job.phase === "mapping" || job.phase === "importing") {
      throw new ReconciliationRequiredError(
        `Unresolved checkpoint for ambiguous ghe-migrator ${job.phase} operation`,
      );
    }
    if (job.phase === "preparing" && !job.ghesImportId) {
      throw new ReconciliationRequiredError("The ghe-migrator prepare outcome was not recorded");
    }
    if (job.phase === "exporting") {
      job = await waitForArchive(
        migration,
        worker,
        options.signal,
        options.emit,
        source,
        recovering,
      );
    }
    if (!job.archivePath) throw new Error("GHES import archive checkpoint is missing");

    ssh = source.createSshClient(config);
    await ssh.connect(options.signal);
    remoteArchivePath = ssh.remoteArchivePath(job.archivePath);
    if (job.phase === "archive_ready" || job.phase === "transferring") {
      updateGhesImportJobCheckpoint(job.id, "transferring");
      emitImportStep(
        options.emit,
        migration.id,
        "transferring",
        "Transferring archive to GHES with SCP",
      );
      remoteArchivePath = await ssh.uploadArchive(job.archivePath, options.signal);
      updateGhesImportJobCheckpoint(job.id, "preparing");
      emitImportStep(options.emit, migration.id, "preparing", "Preparing archive on GHES");
      const guid = await ssh.prepare(remoteArchivePath);
      updateGhesImportJobCheckpoint(job.id, "preparing", { ghesImportId: guid });
      options.signal?.throwIfAborted();
      job = getGhesImportJobByMigrationId(migration.id) as typeof job;
    }

    const guid = job.ghesImportId;
    if (!guid) throw new ReconciliationRequiredError("GHES Migration GUID is missing");
    if (job.phase === "preparing") {
      emitImportStep(
        options.emit,
        migration.id,
        "mapping",
        "Generating and applying GHES mappings",
      );
      const upfront = source.provider === "bitbucket-server";
      let conflicts = upfront ? { stdout: "", stderr: "" } : await ssh.conflicts(guid);
      const sourceKind = `ghe-migrator:${migration.sourceProvider}`;
      let records: string;
      if (upfront && source.localMappingRecords) {
        const start = performance.now();
        try {
          // If a large archive takes longer to scan, use the supported GHES audit instead.
          const timeout = AbortSignal.timeout(5_000);
          const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
          records = await source.localMappingRecords(job.archivePath!, signal);
          emitImportStep(
            options.emit,
            migration.id,
            "mapping",
            `Read source identities from this repository's local archive in ${Math.round(performance.now() - start)} ms`,
          );
        } catch (error) {
          options.signal?.throwIfAborted();
          emitImportStep(
            options.emit,
            migration.id,
            "mapping",
            safeErrorReason(error, "Using GHES mapping audit: archive metadata unavailable"),
          );
          records = (await ssh.mappingRecords(guid, true)).stdout;
        }
      } else records = (await ssh.mappingRecords(guid, upfront)).stdout;
      options.signal?.throwIfAborted();
      const approved = listIdentityMappings(migration.targetApiUrl, migration.targetOrg).filter(
        (mapping) => mapping.status === "approved",
      );
      const mappingsFor = (kind: string) =>
        new Map(
          approved.flatMap((mapping) =>
            mapping.sourceKind === kind && mapping.targetLogin
              ? [[mapping.sourceIdentity, mapping.targetLogin] as const]
              : [],
          ),
        );
      const userMappings = mappingsFor(sourceKind);
      const teamMappings = mappingsFor(`${sourceKind}:team`);
      if (upfront) records = approvedBitbucketRecords(records, userMappings, teamMappings);
      const verifiedLogins = new Set<string>();
      const appliedMappings = new Set<string>();
      let client: ReturnType<typeof createSingleClient> | undefined;
      for (;;) {
        const identities = new Set([
          ...getGhesUserConflicts(conflicts.stdout),
          ...getGhesUserConflicts(records),
        ]);
        for (const identity of identities) {
          discoverIdentityMapping(
            migration.targetApiUrl,
            migration.targetOrg,
            sourceKind,
            identity,
          );
        }
        for (const identity of identities) {
          const login = userMappings.get(identity);
          if (!login || verifiedLogins.has(login)) continue;
          if (source.verifyTargetUser) await source.verifyTargetUser(config, login);
          else {
            client ??= createSingleClient({ token: config.siteAdminToken }, config.profile.apiUrl);
            await client.users.getByUsername({ username: login });
          }
          verifiedLogins.add(login);
        }
        options.signal?.throwIfAborted();
        const mapping = buildGhesMigrationMap(
          conflicts.stdout,
          records,
          config.profile.webUrl,
          migration.targetOrg,
          migration.targetRepo,
          userMappings,
          teamMappings,
        );
        if (!mapping) break;
        if (appliedMappings.size >= MAX_MAPPING_PASSES || appliedMappings.has(mapping)) {
          throw new GhesImportDiagnostic(
            "GHES conflicts remain after applying target mappings; resolve them before importing",
          );
        }
        if (appliedMappings.size > 0) {
          emitImportStep(
            options.emit,
            migration.id,
            "mapping",
            "Resolving conflicts revealed by GHES target mappings",
          );
        }
        updateGhesImportJobCheckpoint(job.id, "mapping");
        if (upfront)
          emitImportStep(
            options.emit,
            migration.id,
            "mapping",
            "Applying mappings on GHES for this repository's import",
          );
        await ssh.map(guid, mapping);
        appliedMappings.add(mapping);
        options.signal?.throwIfAborted();
        if (upfront)
          emitImportStep(
            options.emit,
            migration.id,
            "mapping",
            "Checking GHES for remaining conflicts",
          );
        conflicts = await ssh.conflicts(guid);
        options.signal?.throwIfAborted();
        records = "";
      }
      updateGhesImportJobCheckpoint(job.id, "importing");
      emitImportStep(
        options.emit,
        migration.id,
        "importing",
        "Importing archive into GHES",
        "IMPORTING_GIT",
      );
      await ssh.import(remoteArchivePath, guid);
      updateGhesImportJobCheckpoint(job.id, "auditing");
      options.signal?.throwIfAborted();
      job = getGhesImportJobByMigrationId(migration.id) as typeof job;
    }

    if (job.phase === "auditing") {
      emitImportStep(options.emit, migration.id, "auditing", "Checking for GHES import errors");
      const failures = countGhesAuditFailures((await ssh.auditFailures(guid)).stdout);
      if (failures > 0)
        throw new GhesImportDiagnostic(`GHES import audit found ${failures} failed record(s)`);
      updateGhesImportJobCheckpoint(job.id, "unlocking");
      job = getGhesImportJobByMigrationId(migration.id) as typeof job;
    }
    if (job.phase === "unlocking") {
      emitImportStep(options.emit, migration.id, "unlocking", "Unlocking imported GHES repository");
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
    result = settled(migration, "succeeded");
  } catch (executionError) {
    let error = executionError;
    const current = getGhesImportJobByMigrationId(migration.id);
    if (options.signal?.aborted && current?.phase === "exporting" && current.exporterJobId) {
      try {
        await worker?.cancel(current.exporterJobId, migration.id);
      } catch (cancelError) {
        if (cancelError instanceof ExporterOwnershipError) error = cancelError;
      }
    }
    const afterImport =
      current?.phase === "auditing" ||
      current?.phase === "unlocking" ||
      current?.phase === "succeeded";
    const uncertainApplianceStep =
      afterImport ||
      current?.phase === "mapping" ||
      current?.phase === "importing" ||
      (current?.phase === "preparing" &&
        !current.ghesImportId &&
        !(error instanceof GhesMigratorBusyError));
    const ambiguous =
      uncertainApplianceStep ||
      error instanceof ReconciliationRequiredError ||
      error instanceof ExporterOwnershipError;
    const state = ambiguous
      ? "reconciliation_required"
      : options.signal?.aborted
        ? "cancelled"
        : "failed";
    const phase = current?.phase ?? "initialization";
    const checkpoint = `GHES import${current?.ghesImportId ? ` ${current.ghesImportId}` : ""} reached ${phase}`;
    const detail = afterImport
      ? `${checkpoint}; check audit and unlock for that GUID before continuing.`
      : error instanceof ExportFailedError
        ? error.message
        : error instanceof GhesImportDiagnostic ||
            error instanceof GhesMigratorBusyError ||
            error instanceof ExporterOwnershipError
          ? `${checkpoint}. ${error.message}`
          : `${checkpoint}. ${options.signal?.aborted ? "Operation aborted" : "Operation failed"}`;
    const reason = safeErrorReason(error, detail);
    if (current)
      updateGhesImportJobCheckpoint(
        current.id,
        current.ghesImportId || uncertainApplianceStep ? current.phase : state,
        {
          failureReason: reason,
        },
      );
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
        const current = getGhesImportJobByMigrationId(migration.id);
        const reason = safeErrorReason(
          error,
          `${source.displayName} source unlock requires reconciliation${current?.ghesImportId ? ` for GHES import ${current.ghesImportId} (${current.phase})` : ""}`,
        );
        if (current) {
          updateGhesImportJobCheckpoint(
            current.id,
            current.ghesImportId ? current.phase : "reconciliation_required",
            {
              failureReason: reason,
            },
          );
        }
        result = settled(migration, "reconciliation_required", reason);
      }
    }
  }
  if (result?.state === "succeeded") return completeGhesMigration(result, source, options.emit);
  return result ?? settled(migration, "failed", "GHES migration did not settle");
}

async function completeGhesMigration(
  migration: Migration,
  source: ExporterGhesSourceAdapter,
  emit: MigrationEventEmitter,
) {
  const result = settled(migration, "succeeded");
  emitImportStep(emit, migration.id, "succeeded", "GHES migration completed", "SUCCEEDED");
  try {
    result.targetCounts = await (source.fetchTargetCounts ?? fetchMigrationTargetCounts)(result);
  } catch (error) {
    const reason = targetCountFailureReason(error);
    console.warn(`Target resource counts unavailable for migration ${migration.id}: ${reason}`);
    emitImportStep(
      emit,
      migration.id,
      "succeeded",
      `Migration succeeded, but target resource counts could not be collected: ${reason}. Use Fetch counts on the migration detail page to retry.`,
      "SUCCEEDED",
    );
  }
  return result;
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
