import type {
  BatchListItem,
  BatchMigrationRequest,
  BatchSummary,
  CreateMigrationRequest,
  Migration,
  MigrationEvent,
  MigrationState,
  MigrationStats,
  MigrationStatsFilters,
  PaginatedResult,
  PaginationParams,
  RestartMigrationRequest,
} from "$lib/migrate/types";
import { isCancellableMigrationState, isExecutingMigrationState } from "$lib/migration-state";
import {
  GITLAB_GHES_PAUSE_REASON,
  isPausedPersistedRoute,
  supportsMigrationTarget,
} from "$lib/migration-target";
import { validateCredentialScope } from "$lib/server/core/credential-scope";
import { getDb } from "$lib/server/core/db";
import { safeErrorReason } from "$lib/server/core/safe-error";
import { getMigrationTargetProfile, requireMigrationTargetProfile } from "$lib/server/core/targets";
import { getSourceProjectIdentity, getSourceProviderAdapter } from "$lib/source-provider";
import {
  getBatchListItem,
  getBatchMigrations,
  getBatchMigrationsPaginated,
  getBatchSourceProviderValues,
  getBatchSummary,
  getRestartableBatchSourceProviderValues,
  listBatchItemsPaginated,
  searchBatchItemsPaginated,
} from "./database/batches";
import { getEvents, getRecentActivity, insertEvent } from "./database/events";
import {
  getGhesImportJobByMigrationId,
  updateGhesImportJobCheckpoint,
} from "./database/import-jobs";
import {
  claimMigrationCancellation,
  claimQueuedMigrationCancellation,
  getBatchMigrationByItem,
  getMigration,
  hasUnreconciledGhesImport,
  insertMigration,
  listMigrationsPaginated,
  requiresManualImportReview,
  resetMigration,
  searchMigrationsPaginated,
} from "./database/migrations";
import { getMigrationStats, getStateCounts } from "./database/stats";
import { getExecutorForMigration, getRegisteredMigrationExecutor } from "./executors/registry";
import { MANUAL_IMPORT_REVIEW } from "./ghes/job";
import { resolveEffectiveSourceApiUrl } from "./ports/source-runtime";
import { activeMigrationRuns } from "./runs/active";
import {
  broadcastMigrationEvent,
  closeMigrationEventStream,
  createMigrationEventHandler,
  insertLifecycleStep,
  subscribeToGlobalMigrationEvents,
  subscribeToMigrationEvents,
} from "./runs/events";
import { createMigrationRunFinisher } from "./runs/finish";
import {
  drainMigrationQueue,
  launchClaimedMigration,
  recordGhesQueueHold,
  shouldQueueMigration,
} from "./runs/queue";
import { recoverMigrationRuns } from "./runs/recovery";
import { auditSourceTlsOverride } from "./runs/source-tls-audit";
import {
  determineAuthModeFromRequest,
  migrationTlsPolicyError,
  requestForMigration,
  requireCredentialScope,
  safeParsePersistedRequestOptions,
  serializeRequestOptions,
} from "./validate";

export { MAX_CONCURRENT_MIGRATIONS } from "./runs/queue";
export {
  subscribeToGlobalMigrationEvents as subscribeGlobal,
  subscribeToMigrationEvents as subscribe,
};

function drainQueue(): void {
  drainMigrationQueue(launchPipeline);
}

const finisher = createMigrationRunFinisher(drainQueue);

// The composition root supplies the cross-domain inventory/grant check. Never
// treat an unset policy (including during recovery) as administrator access.
type OwnedDispatchPolicy = (migration: Migration) => CreateMigrationRequest;
let ownedDispatchPolicy: OwnedDispatchPolicy | undefined;
export function setOwnedDispatchPolicy(policy: OwnedDispatchPolicy): void {
  ownedDispatchPolicy = policy;
}

function ownedRequest(migration: Migration): CreateMigrationRequest {
  if (!ownedDispatchPolicy) throw new Error("Operator migration policy unavailable");
  return ownedDispatchPolicy(migration);
}

function launchPipeline(id: string, request: CreateMigrationRequest): boolean {
  const migration = getMigration(id);
  if (!migration) throw new Error("Migration not found");
  const executor = getExecutorForMigration(migration);
  const registration = activeMigrationRuns.claim(id, migration.state === "cancelling");
  if (!registration) return false;
  const promise = Promise.resolve()
    .then(() => {
      const effective =
        migration.ownerUserId !== undefined
          ? ownedRequest(migration)
          : requestForMigration(migration, request);
      const error = migrationTlsPolicyError(effective);
      if (effective.noSslVerify)
        auditSourceTlsOverride(migration, "dispatch", error ? "denied" : "allowed", undefined);
      if (error) throw new Error(error);
      return executor.run({
        ...effective,
        id,
        signal: registration.signal,
        emit: createMigrationEventHandler(id, registration.token),
      });
    })
    .then((result) => finisher.settleResult(id, registration.token, result))
    .catch((error) => finisher.settleError(id, registration.token, error));
  activeMigrationRuns.attach(id, registration.token, promise);
  return true;
}

function launchRecoveredPipeline(migration: Migration): boolean {
  const executor = getExecutorForMigration(migration);
  const registration = activeMigrationRuns.claim(migration.id);
  if (!registration) return false;
  const promise = Promise.resolve()
    .then(() => {
      let resumable = migration;
      if (migration.ownerUserId !== undefined) {
        try {
          const request = ownedRequest(migration);
          resumable = { ...migration, requestOptions: serializeRequestOptions(request) };
        } catch {
          // A recovered job may already have remote side effects.
          return {
            ...migration,
            state: "reconciliation_required" as const,
            failureReason: "Operator migration authorization no longer permits recovery",
            completedAt: new Date().toISOString(),
          };
        }
      }
      const options = safeParsePersistedRequestOptions(resumable.requestOptions);
      if (options?.noSslVerify) {
        const error = migrationTlsPolicyError(requestForMigration(resumable, options));
        auditSourceTlsOverride(resumable, "recovery", error ? "denied" : "allowed", undefined);
        if (error)
          return {
            ...resumable,
            state: "reconciliation_required" as const,
            failureReason: error,
            completedAt: new Date().toISOString(),
          };
      }
      return executor.resume(
        resumable,
        createMigrationEventHandler(migration.id, registration.token),
        registration.signal,
      );
    })
    .then((result) => finisher.settleResult(migration.id, registration.token, result))
    .catch((error) => finisher.settleError(migration.id, registration.token, error));
  activeMigrationRuns.attach(migration.id, registration.token, promise);
  return true;
}

function requireStartRoute(
  request: Pick<CreateMigrationRequest, "sourceProvider" | "targetProfileId">,
) {
  const sourceProvider = request.sourceProvider ?? "github";
  const target = requireMigrationTargetProfile(request.targetProfileId);
  if (!supportsMigrationTarget(sourceProvider, target.platform)) {
    throw new TypeError(
      `${getSourceProviderAdapter(sourceProvider).displayName} cannot target ${target.platform.toUpperCase()}`,
    );
  }
  getRegisteredMigrationExecutor({ sourceProvider, targetPlatform: target.platform });
  return target;
}

function newMigration(request: CreateMigrationRequest, batchId?: string): Migration {
  const sourceProvider = request.sourceProvider ?? "github";
  const target = requireStartRoute(request);
  requireCredentialScope(request);
  const identity = getSourceProjectIdentity(sourceProvider, request.sourceRepo);
  return {
    id: Bun.randomUUIDv7(),
    batchId: batchId ?? null,
    githubMigrationId: null,
    sourceProvider,
    sourceApiUrl: resolveEffectiveSourceApiUrl(request),
    targetProfileId: target.id,
    targetPlatform: target.platform,
    targetApiUrl: target.apiUrl,
    sourceOrg: identity.namespace,
    sourceRepo: identity.name,
    targetOrg: request.targetOrg,
    targetRepo: request.targetRepo || identity.name,
    state: "pending",
    failureReason: null,
    migrationLogUrl: null,
    warningsCount: 0,
    sourceCounts: null,
    targetCounts: null,
    sourceSizeKb: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    elapsedSeconds: null,
    authMode: null,
    requestOptions: null,
  };
}

/** Commit the complete batch and its ownership before making any item runnable. */
export function enqueueOwnedBatch(ownerUserId: string, requests: CreateMigrationRequest[]) {
  if (!ownerUserId || !requests.length) throw new Error("Empty operator batch");
  const batchId = Bun.randomUUIDv7();
  const queued = getDb().transaction(() =>
    requests.map((input) => {
      const migration = newMigration(input, batchId);
      migration.ownerUserId = ownerUserId;
      const request = ownedRequest(migration);
      migration.state = "queued";
      migration.authMode = determineAuthModeFromRequest(request);
      migration.requestOptions = serializeRequestOptions(request);
      insertMigration(migration);
      recordGhesQueueHold(migration);
      return { id: migration.id, request };
    }),
  )();
  for (const { id, request } of queued) activeMigrationRuns.enqueue(id, request);
  drainQueue();
  return { batchId, jobIds: queued.map(({ id }) => id) };
}

export function start(
  request: CreateMigrationRequest,
  batchId?: string,
  actorUserId?: string | null,
): Migration {
  const migration = newMigration(request, batchId);
  migration.requestOptions = serializeRequestOptions(requestForMigration(migration, request));
  migration.authMode = determineAuthModeFromRequest(request);
  let queued = false;
  let existing: Migration | null = null;
  getDb().transaction(() => {
    if (shouldQueueMigration(migration)) {
      queued = true;
      migration.state = "queued";
    }
    try {
      insertMigration(migration);
    } catch (error) {
      existing = batchId
        ? getBatchMigrationByItem(
            batchId,
            migration.sourceOrg,
            migration.sourceRepo,
            migration.targetRepo,
          )
        : null;
      if (!existing) throw error;
    }
    if (!existing && queued) recordGhesQueueHold(migration);
    if (!existing && request.noSslVerify)
      auditSourceTlsOverride(migration, "start", "admitted", actorUserId);
  })();
  if (existing) return existing;
  if (queued) activeMigrationRuns.enqueue(migration.id, request);
  else if (!launchClaimedMigration(migration.id, request, launchPipeline))
    throw new Error("Migration could not be launched");
  return migration;
}

export function cancel(migrationId: string): boolean {
  const migration = getMigration(migrationId);
  if (!migration) return false;
  try {
    getExecutorForMigration(migration);
  } catch {
    return false;
  }
  const queued = migration.state === "queued";
  if (!queued && !isExecutingMigrationState(migration.state)) return false;
  const event = getDb().transaction(() => {
    const claim = queued ? claimQueuedMigrationCancellation : claimMigrationCancellation;
    if (!claim(migrationId)) return null;
    return insertLifecycleStep(
      migrationId,
      queued ? "Queued migration cancelled before execution" : "Migration cancellation requested",
    );
  })();
  if (!event) return false;
  broadcastMigrationEvent(migrationId, event);
  if (queued) {
    activeMigrationRuns.dropQueued(migrationId);
    closeMigrationEventStream(migrationId, "cancelled");
    return true;
  }
  activeMigrationRuns.abort(migrationId);
  return true;
}

export class MigrationRestartConflict extends Error {}

function restartRequest(
  existing: Migration,
  credentials: RestartMigrationRequest,
): CreateMigrationRequest {
  const stored = safeParsePersistedRequestOptions(existing.requestOptions);
  if (!stored && existing.targetPlatform === "ghec" && !credentials.targetRepoVisibility) {
    throw new MigrationRestartConflict(
      "Cannot restart with saved settings: the original options are unavailable. Review the options and select a target visibility.",
    );
  }
  return requestForMigration(existing, { ...stored, ...credentials });
}

export function restart(
  migrationId: string,
  credentials: RestartMigrationRequest,
  actorUserId?: string | null,
): Migration {
  const existing = getMigration(migrationId);
  if (!existing) throw new Error("Migration not found");
  getExecutorForMigration(existing);
  if (activeMigrationRuns.isActive(migrationId)) {
    throw new MigrationRestartConflict(
      "Cannot restart migration while its previous run is still stopping",
    );
  }
  if (existing.state !== "failed" && existing.state !== "cancelled") {
    throw new MigrationRestartConflict(`Cannot restart migration in state "${existing.state}"`);
  }
  if (existing.targetPlatform === "ghes") {
    if (requiresManualImportReview(migrationId))
      throw new MigrationRestartConflict(MANUAL_IMPORT_REVIEW);
    const target = getMigrationTargetProfile(existing.targetProfileId);
    if (target?.platform !== "ghes" || target.apiUrl !== existing.targetApiUrl)
      throw new MigrationRestartConflict(
        "The saved GHES target is missing or changed. Restore the original destination before restarting.",
      );
  }
  const request =
    existing.ownerUserId !== undefined
      ? ownedRequest(existing)
      : restartRequest(existing, credentials);
  requireCredentialScope(request);
  const payload = {
    message: `Migration restarted (previously ${existing.state})`,
    previousState: existing.state,
  };
  const event: MigrationEvent = {
    migrationId,
    eventType: "restart",
    phase: null,
    payload,
    createdAt: new Date().toISOString(),
  };
  let queued = false;
  getDb().transaction(() => {
    queued = shouldQueueMigration(existing);
    if (
      !resetMigration(
        migrationId,
        queued ? "queued" : "pending",
        determineAuthModeFromRequest(request),
        serializeRequestOptions(request),
      )
    )
      throw new Error("Migration was already claimed for restart");
    event.id = insertEvent(event);
    if (queued) recordGhesQueueHold(existing);
    if (request.noSslVerify) auditSourceTlsOverride(existing, "restart", "admitted", actorUserId);
  })();
  broadcastMigrationEvent(migrationId, event);
  if (queued) activeMigrationRuns.enqueue(migrationId, request);
  else if (!launchClaimedMigration(migrationId, request, launchPipeline))
    throw new Error("Migration restart could not be launched");
  const updated = getMigration(migrationId);
  if (!updated) throw new Error(`Migration ${migrationId} not found after restart`);
  return updated;
}

export function confirmRestart(migrationId: string, confirmation: string): Migration {
  const existing = getMigration(migrationId);
  if (!existing) throw new Error("Migration not found");
  const paused = isPausedPersistedRoute(existing);
  const executable =
    !paused && supportsMigrationTarget(existing.sourceProvider, existing.targetPlatform);
  const expected = `${existing.targetOrg}/${existing.targetRepo}`;
  if (confirmation !== expected)
    throw new MigrationRestartConflict(`Confirmation must exactly match "${expected}"`);
  const event: MigrationEvent = {
    migrationId,
    eventType: "step",
    phase: null,
    payload: {
      confirmedInactive: true,
      message:
        executable && requiresManualImportReview(migrationId)
          ? `Manual review submitted: remote GHES operation reported inactive. ${MANUAL_IMPORT_REVIEW}`
          : paused
            ? "Manual review submitted: remote GHES operation reported inactive; GitLab-to-GHES execution remains paused."
            : executable
              ? "Manual review submitted: remote migration reported inactive; migration is now eligible for restart."
              : "Manual review submitted: remote migration reported inactive; execution remains unsupported for this route.",
    },
    createdAt: new Date().toISOString(),
  };
  getDb().transaction(() => {
    if (paused && !hasUnreconciledGhesImport(migrationId))
      throw new MigrationRestartConflict(GITLAB_GHES_PAUSE_REASON);
    const result = getDb()
      .prepare(
        "UPDATE migrations SET state = 'failed' WHERE id = ? AND state = 'reconciliation_required'",
      )
      .run(migrationId);
    if (result.changes !== 1) {
      throw new MigrationRestartConflict(
        `Cannot confirm restart for migration in state "${getMigration(migrationId)?.state ?? "missing"}"`,
      );
    }
    const job = getGhesImportJobByMigrationId(migrationId);
    if (executable && job?.phase === "preparing" && !job.ghesImportId) {
      updateGhesImportJobCheckpoint(job.id, "failed", {
        failureReason: job.failureReason ?? undefined,
      });
    }
    event.id = insertEvent(event);
  })();
  broadcastMigrationEvent(migrationId, event);
  if (paused || existing.targetPlatform === "ghes") drainQueue();
  return getMigration(migrationId) as Migration;
}

export function startBatch(
  request: BatchMigrationRequest,
  requestedBatchId?: string,
  actorUserId?: string | null,
): BatchSummary {
  const sourceProvider = request.sourceProvider ?? "github";
  if (!request.targetProfileId?.trim()) throw new TypeError("Choose a destination for this batch.");
  requireStartRoute(request);
  const scopeError = validateCredentialScope(request);
  if (scopeError) throw new TypeError(scopeError);
  const batchId = requestedBatchId ?? Bun.randomUUIDv7();
  const items =
    request.items ??
    request.repos?.map((sourceRepo) => ({ sourceRepo, targetRepo: undefined })) ??
    [];
  const existingItems = new Set(
    (getBatchSummary(batchId)?.migrations ?? []).map((migration) =>
      `${migration.sourceOrg}/${migration.sourceRepo}\0${migration.targetRepo}`.toLowerCase(),
    ),
  );
  for (const item of items) {
    const sourceRepo = item.sourceRepo.trim();
    if (!sourceRepo) continue;
    const targetRepo = item.targetRepo || getSourceProjectIdentity(sourceProvider, sourceRepo).name;
    const key = `${sourceRepo}\0${targetRepo}`.toLowerCase();
    if (existingItems.has(key)) continue;
    existingItems.add(key);
    start({ ...request, sourceProvider, sourceRepo, targetRepo }, batchId, actorUserId);
  }
  const summary = getBatchSummary(batchId);
  if (!summary) throw new Error("Batch contains no migrations");
  return summary;
}

export function cancelBatch(batchId: string): number {
  let count = 0;
  for (const migration of getBatchMigrations(batchId)) {
    if (isCancellableMigrationState(migration.state) && cancel(migration.id)) count += 1;
  }
  return count;
}

export function restartBatch(
  batchId: string,
  credentials: RestartMigrationRequest,
  validate?: (request: CreateMigrationRequest) => string | null,
  actorUserId?: string | null,
) {
  for (const provider of getRestartableBatchSourceProviderValues(batchId)) {
    if (!getSourceProviderAdapter(provider as Migration["sourceProvider"])) {
      throw new TypeError(`Migration restart is unavailable for source provider '${provider}'`);
    }
  }
  const results = { restarted: 0, errors: [] as Array<{ id: string; error: string }> };
  for (const migration of getBatchMigrations(batchId, true)) {
    try {
      const authError = validate?.(restartRequest(migration, credentials));
      if (authError) {
        results.errors.push({ id: migration.id, error: authError });
        continue;
      }
      restart(migration.id, credentials, actorUserId);
      results.restarted += 1;
    } catch (error) {
      results.errors.push({
        id: migration.id,
        error:
          error instanceof MigrationRestartConflict
            ? error.message
            : error instanceof Error && error.message === GITLAB_GHES_PAUSE_REASON
              ? GITLAB_GHES_PAUSE_REASON
              : safeErrorReason(error, "Migration restart failed"),
      });
    }
  }
  return results;
}

export const get = getMigration;
export const listPaginated = listMigrationsPaginated;
export const searchPaginated = searchMigrationsPaginated;
export const getBatch = getBatchSummary;
export { getRestartableBatchCount } from "./database/batches";
export const listBatchesPaginated = listBatchItemsPaginated;
export const searchBatchesPaginated = searchBatchItemsPaginated;
export const recentActivity = getRecentActivity;
export const events = getEvents;

export function getBatchSourceProviders(batchId: string): string[] {
  return getBatchSourceProviderValues(batchId);
}
export function getBatchPaginated(
  batchId: string,
  params: PaginationParams,
): { summary: BatchListItem; migrations: PaginatedResult<Migration> } | null {
  const summary = getBatchListItem(batchId);
  return summary ? { summary, migrations: getBatchMigrationsPaginated(batchId, params) } : null;
}
export function stats(filters?: MigrationStatsFilters): MigrationStats {
  return getMigrationStats(filters);
}
export function stateCounts(): Record<MigrationState, number> {
  return getStateCounts();
}
export function recoverOrphans(): void {
  recoverMigrationRuns({ launchRecoveredPipeline, drainQueue });
}
