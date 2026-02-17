/**
 * Concurrency manager — semaphore(10), abort controllers, SSE broadcast.
 * This is the top-level entry point that wires migration.ts → store.ts → SSE.
 */
// bun:sqlite built-in UUIDv7 — time-sortable, zero deps
import type {
  AuthMode,
  BatchListItem,
  BatchMigrationRequest,
  BatchSummary,
  Counts,
  CreateMigrationRequest,
  Migration,
  MigrationEvent,
  MigrationState,
  PaginatedResult,
  PaginationParams,
  RestartMigrationRequest,
} from "$lib/types";
import {
  isSourceAppConfigured,
  isSourceAuthAvailable,
  isTargetAppConfigured,
  isTargetAuthAvailable,
} from "./auth";
import { resumeMigration, runMigrationPipeline } from "./migration";
import {
  getActiveMigrationCount,
  getBatchListItem,
  getBatchMigrations,
  getBatchMigrationsPaginated,
  getBatchSummary,
  getDb,
  getEvents,
  getMigration,
  getNextQueuedMigration,
  getQueuedEnvMigrations,
  getRecoverableMigrations,
  insertEvent,
  insertMigration,
  listBatchItemsPaginated,
  listMigrations,
  listMigrationsPaginated,
  resetMigration,
  updateMigrationState,
} from "./store";
import { extractOrg, extractRepo } from "./util";

/** GitHub-imposed concurrent migration limit per organization. */
const MAX_CONCURRENT = 10;

/** Active migration abort controllers, keyed by migration ID. */
const controllers = new Map<string, AbortController>();

/**
 * Determine auth mode from a request without running the full pipeline.
 * Mirror of migration.ts's determineAuthMode but operates on CreateMigrationRequest.
 */
function determineAuthModeFromRequest(req: CreateMigrationRequest): AuthMode {
  if (req.sourceToken || req.targetToken) return "pat";
  if (req.sourceApp || req.targetApp) return "request-app";
  if (isSourceAppConfigured() && isTargetAppConfigured()) return "env-app";
  if (isSourceAuthAvailable() && isTargetAuthAvailable()) return "env-pat";
  return "pat";
}

/** Parse JSON safely, returning null on failure. */
function safeParseJson(json: string): Record<string, unknown> | null {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * In-memory queue: holds the CreateMigrationRequest for each queued migration
 * so we can start it later when a slot opens. Keyed by migration ID.
 *
 * Per-request credentials (PATs / App keys) live here — never persisted.
 * On server restart, env-auth queued migrations are recovered from the DB
 * (request_options column + env-var credentials). Non-env queued items are
 * marked failed (their credentials are lost).
 */
const queuedRequests = new Map<string, CreateMigrationRequest>();

// ── Shared emit / result helpers ────────────────────────────────────────────

/**
 * Build a `(event: MigrationEvent) => void` callback that persists the
 * event, updates the migration row in SQLite, and broadcasts via SSE.
 *
 * Used by both `start()` and `recoverOrphans()` so the logic stays DRY.
 */
function createEmitHandler(id: string): (event: MigrationEvent) => void {
  return (event: MigrationEvent) => {
    // Wrap event persistence + state update in a transaction so the DB
    // is never in a state where the event row exists but the migration
    // row hasn't been updated (or vice-versa).
    getDb().transaction(() => {
      // 1. Persist event row and capture the auto-increment ID.
      const eventId = insertEvent(event);
      // Mutate in-place so broadcastEvent sees the id — safe because
      // callers (monitor / pipeline) create a fresh object per emit.
      event.id = eventId;

      // 2. Update migration state from terminal / progress events immediately
      //    so the DB reflects changes before the SSE broadcast triggers a
      //    client-side refresh.
      if (event.eventType === "complete") {
        updateMigrationState(id, "succeeded", {
          completedAt: new Date().toISOString(),
          elapsedSeconds: event.payload.elapsed,
        });
      } else if (event.eventType === "failure") {
        updateMigrationState(id, "failed", {
          failureReason:
            event.payload.detail?.failureReason || event.payload.error || "Unknown error",
          completedAt: new Date().toISOString(),
        });
      } else if (event.eventType === "step") {
        // Keep state as 'running' once pipeline starts, propagate source counts.
        const current = getMigration(id);
        const newState = current?.state === "pending" ? "running" : (current?.state ?? "running");
        const extra: Parameters<typeof updateMigrationState>[2] = {};
        if (event.payload.counts) {
          extra.sourceCounts = event.payload.counts;
        }
        if (newState !== current?.state || Object.keys(extra).length > 0) {
          updateMigrationState(id, newState as MigrationState, extra);
        }
      } else if (event.eventType === "snapshot") {
        // Propagate live data from snapshots to the migration record.
        // Guard: don't overwrite a terminal state (e.g. cancelled) back to running.
        const current = getMigration(id);
        if (current && ["succeeded", "failed", "cancelled"].includes(current.state)) {
          // Skip — migration already reached a terminal state.
        } else {
          const snap = event.payload.progress?.current;
          const srcCounts = event.payload.sourceCounts;
          if (snap) {
            const extra: Parameters<typeof updateMigrationState>[2] = {};
            if (snap.warningsCount > 0) extra.warningsCount = snap.warningsCount;
            if (snap.migrationLogUrl) extra.migrationLogUrl = snap.migrationLogUrl;
            const tgt: Counts = {
              commits: snap.commits,
              branches: snap.branches,
              tags: snap.tags,
              issues: snap.issues,
              pullRequests: snap.pullRequests,
              releases: snap.releases,
            };
            extra.targetCounts = tgt;
            if (srcCounts) extra.sourceCounts = srcCounts;
            if (Object.keys(extra).length > 0) {
              updateMigrationState(id, "running", extra);
            }
          }
        }
      }
    })();

    // 3. Broadcast to SSE subscribers (outside transaction — side-effect).
    broadcastEvent(id, event);
  };
}

/** Shared `.then()` handler for the fire-and-forget pipeline / resume promise. */
function handlePipelineResult(id: string, result: Migration): void {
  // Guard: if the migration has already reached a terminal state (e.g. via
  // a "complete" or "failure" event in createEmitHandler, or a cancellation),
  // skip the redundant update to avoid overwriting it.
  const current = getMigration(id);
  if (current && ["succeeded", "failed", "cancelled"].includes(current.state)) {
    controllers.delete(id);
    drainQueue();
    return;
  }

  updateMigrationState(id, result.state, {
    githubMigrationId: result.githubMigrationId ?? undefined,
    sourceCounts: result.sourceCounts ?? undefined,
    targetCounts: result.targetCounts ?? undefined,
    // result.warningsCount is always 0 (not updated during monitoring).
    // Use || undefined so COALESCE(NULL, warnings_count) preserves the
    // value accumulated from snapshot events.
    warningsCount: result.warningsCount || undefined,
    completedAt: result.completedAt ?? undefined,
    elapsedSeconds: result.elapsedSeconds ?? undefined,
    failureReason: result.failureReason ?? undefined,
    migrationLogUrl: result.migrationLogUrl ?? undefined,
  });
  controllers.delete(id);
  drainQueue();
}

/** Shared `.catch()` handler for unexpected pipeline crashes. */
function handlePipelineError(id: string, err: unknown): void {
  console.error(`Migration ${id} crashed:`, err);
  updateMigrationState(id, "failed", {
    failureReason: err instanceof Error ? err.message : String(err),
    completedAt: new Date().toISOString(),
  });
  controllers.delete(id);
  drainQueue();
}

// ── Queue drain ─────────────────────────────────────────────────────────────

/**
 * Promote queued migrations to running, filling available concurrency slots.
 * Called automatically whenever a migration completes, fails, or is cancelled.
 * FIFO order — oldest queued item starts first.
 */
function drainQueue(): void {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Atomic: check concurrency + dequeue + transition in a single transaction
    // so concurrent drainQueue() calls can't both see active < MAX_CONCURRENT.
    const next = getDb().transaction(() => {
      const active = getActiveMigrationCount();
      if (active >= MAX_CONCURRENT) return null;
      const queued = getNextQueuedMigration();
      if (!queued) return null;
      updateMigrationState(queued.id, "pending");
      return queued;
    })();

    if (!next) break;

    const req = queuedRequests.get(next.id);
    if (!req) {
      // Credentials lost (shouldn't happen unless server logic is wrong).
      console.error(`[manager] No queued request for migration ${next.id} — marking failed`);
      updateMigrationState(next.id, "failed", {
        failureReason: "Queued migration request lost (internal error)",
        completedAt: new Date().toISOString(),
      });
      continue;
    }
    queuedRequests.delete(next.id);

    // Launch the pipeline.
    const ac = new AbortController();
    controllers.set(next.id, ac);

    console.log(`[manager] Dequeuing migration ${next.id} (${next.sourceOrg}/${next.sourceRepo})`);

    runMigrationPipeline({
      ...req,
      id: next.id,
      signal: ac.signal,
      emit: createEmitHandler(next.id),
    })
      .then((result) => handlePipelineResult(next.id, result))
      .catch((err) => handlePipelineError(next.id, err));
  }
}

/** SSE subscribers: migrationId → Set<writable stream controllers>. */
const sseSubscribers = new Map<string, Set<ReadableStreamDefaultController<string>>>();

/** Global subscribers (dashboard — receive events for ALL migrations). */
const globalSubscribers = new Set<ReadableStreamDefaultController<string>>();

// ── Public API ──────────────────────────────────────────────────────────────

export function start(req: CreateMigrationRequest, batchId?: string): Migration {
  const id = Bun.randomUUIDv7();
  const now = new Date().toISOString();

  // Determine source org/repo from the request.
  const sourceOrg = extractOrg(req.sourceRepo);
  const sourceRepoName = extractRepo(req.sourceRepo);

  const migration: Migration = {
    id,
    batchId: batchId ?? null,
    githubMigrationId: null,
    sourceApiUrl: req.sourceApiUrl || "https://api.github.com",
    sourceOrg,
    sourceRepo: sourceRepoName,
    targetOrg: req.targetOrg,
    targetRepo: req.targetRepo || sourceRepoName,
    state: "pending",
    failureReason: null,
    migrationLogUrl: null,
    warningsCount: 0,
    sourceCounts: null,
    targetCounts: null,
    startedAt: now,
    completedAt: null,
    elapsedSeconds: null,
    authMode: null,
    requestOptions: null,
  };

  // Atomic check-and-insert: wrap concurrency check + insert in a
  // transaction so no two callers can race past MAX_CONCURRENT.
  getDb().transaction(() => {
    const active = getActiveMigrationCount();
    if (active >= MAX_CONCURRENT) {
      throw new Error(
        `Concurrency limit reached (${MAX_CONCURRENT}). Wait for a running migration to complete.`,
      );
    }
    insertMigration(migration);
  })();

  // Create an AbortController for cancellation.
  const ac = new AbortController();
  controllers.set(id, ac);

  // Fire-and-forget: run the pipeline in the background.
  runMigrationPipeline({
    ...req,
    id,
    signal: ac.signal,
    emit: createEmitHandler(id),
  })
    .then((result) => handlePipelineResult(id, result))
    .catch((err) => handlePipelineError(id, err));

  return migration;
}

export function cancel(migrationId: string): boolean {
  // Handle queued migrations — no abort controller, just remove from queue.
  if (queuedRequests.has(migrationId)) {
    queuedRequests.delete(migrationId);
    updateMigrationState(migrationId, "cancelled", {
      completedAt: new Date().toISOString(),
    });
    return true;
  }

  const ac = controllers.get(migrationId);
  if (!ac) return false;
  ac.abort();
  controllers.delete(migrationId);
  updateMigrationState(migrationId, "cancelled", {
    completedAt: new Date().toISOString(),
  });
  drainQueue();
  return true;
}

// ── Batch operations ────────────────────────────────────────────────────────

/**
 * Enqueue a migration: insert a DB row with state='queued' and store the
 * request in memory so drainQueue() can launch it when a slot opens.
 */
function enqueue(req: CreateMigrationRequest, batchId: string): Migration {
  const id = Bun.randomUUIDv7();
  const now = new Date().toISOString();
  const sourceOrg = extractOrg(req.sourceRepo);
  const sourceRepoName = extractRepo(req.sourceRepo);

  // Determine auth mode early so queued env-auth migrations can survive restarts.
  const authMode = determineAuthModeFromRequest(req);

  // Persist non-credential request options so they can be reconstructed on recovery.
  const requestOptions = JSON.stringify({
    sourceApiUrl: req.sourceApiUrl,
    sourceRepo: req.sourceRepo,
    targetOrg: req.targetOrg,
    targetRepo: req.targetRepo,
    noSslVerify: req.noSslVerify,
    skipReleases: req.skipReleases,
    lockSource: req.lockSource,
    archiveSource: req.archiveSource,
    targetRepoVisibility: req.targetRepoVisibility,
    directPassthrough: req.directPassthrough,
  });

  const migration: Migration = {
    id,
    batchId,
    githubMigrationId: null,
    sourceApiUrl: req.sourceApiUrl || "https://api.github.com",
    sourceOrg,
    sourceRepo: sourceRepoName,
    targetOrg: req.targetOrg,
    targetRepo: req.targetRepo || sourceRepoName,
    state: "queued",
    failureReason: null,
    migrationLogUrl: null,
    warningsCount: 0,
    sourceCounts: null,
    targetCounts: null,
    startedAt: now,
    completedAt: null,
    elapsedSeconds: null,
    authMode,
    requestOptions,
  };

  insertMigration(migration);
  queuedRequests.set(id, req);
  return migration;
}

export function startBatch(req: BatchMigrationRequest): BatchSummary {
  const batchId = Bun.randomUUIDv7();
  const migrations: Migration[] = [];

  for (const repo of req.repos) {
    const trimmed = repo.trim();
    if (!trimmed) continue;

    // Each repo in the batch shares the same config but gets its own migration.
    const migReq: CreateMigrationRequest = {
      sourceApiUrl: req.sourceApiUrl,
      sourceRepo: trimmed,
      targetOrg: req.targetOrg,
      sourceToken: req.sourceToken,
      targetToken: req.targetToken,
      sourceApp: req.sourceApp,
      targetApp: req.targetApp,
      noSslVerify: req.noSslVerify,
      skipReleases: req.skipReleases,
      lockSource: req.lockSource,
      targetRepoVisibility: req.targetRepoVisibility,
      directPassthrough: req.directPassthrough,
      archiveSource: req.archiveSource,
    };

    // Try to start immediately; if at capacity, queue for later.
    try {
      const migration = start(migReq, batchId);
      migrations.push(migration);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Concurrency limit reached")) {
        // Queue remaining repos — they'll auto-start as slots open.
        const migration = enqueue(migReq, batchId);
        migrations.push(migration);
      } else {
        throw err;
      }
    }
  }

  const now = new Date().toISOString();
  return {
    id: batchId,
    totalCount: migrations.length,
    queuedCount: migrations.filter((m) => m.state === "queued").length,
    pendingCount: migrations.filter((m) => m.state === "pending").length,
    runningCount: migrations.filter((m) => m.state === "running").length,
    succeededCount: 0,
    failedCount: 0,
    cancelledCount: 0,
    startedAt: migrations[0]?.startedAt || now,
    migrations,
  };
}

export function cancelBatch(batchId: string): number {
  const migrations = getBatchMigrations(batchId);
  let cancelledCount = 0;
  for (const m of migrations) {
    if (m.state === "queued" || m.state === "pending" || m.state === "running") {
      if (cancel(m.id)) cancelledCount++;
    }
  }
  return cancelledCount;
}

// ── Restart operations ──────────────────────────────────────────────────────

/**
 * Restart a failed or cancelled migration.
 * Reuses the same migration ID — clears transient fields and re-runs the pipeline.
 * Credentials must be provided (or env-app must be configured).
 */
export function restart(migrationId: string, creds: RestartMigrationRequest): Migration {
  const existing = getMigration(migrationId);
  if (!existing) throw new Error("Migration not found");
  if (existing.state !== "failed" && existing.state !== "cancelled") {
    throw new Error(`Cannot restart migration in state "${existing.state}"`);
  }

  // Build a CreateMigrationRequest from DB fields + provided creds.
  const req: CreateMigrationRequest = {
    sourceApiUrl: existing.sourceApiUrl,
    sourceRepo: `${existing.sourceOrg}/${existing.sourceRepo}`,
    targetOrg: existing.targetOrg,
    targetRepo: existing.targetRepo,
    sourceToken: creds.sourceToken,
    targetToken: creds.targetToken,
    sourceApp: creds.sourceApp,
    targetApp: creds.targetApp,
    noSslVerify: creds.noSslVerify,
    skipReleases: creds.skipReleases,
    lockSource: creds.lockSource,
    archiveSource: creds.archiveSource,
    targetRepoVisibility: creds.targetRepoVisibility,
    directPassthrough: creds.directPassthrough,
  };

  // Atomic: check concurrency + reset the row.
  let queued = false;
  getDb().transaction(() => {
    const active = getActiveMigrationCount();
    if (active >= MAX_CONCURRENT) {
      queued = true;
      resetMigration(migrationId, "queued");
    } else {
      resetMigration(migrationId, "pending");
    }
  })();

  // Insert a "restart" audit event.
  const restartEvent: MigrationEvent = {
    migrationId,
    eventType: "restart",
    phase: null,
    payload: { message: `Migration restarted (previously ${existing.state})` },
    createdAt: new Date().toISOString(),
  };
  const eventId = insertEvent(restartEvent);
  restartEvent.id = eventId;
  broadcastEvent(migrationId, restartEvent);

  // Start pipeline or queue.
  if (queued) {
    queuedRequests.set(migrationId, req);
  } else {
    const ac = new AbortController();
    controllers.set(migrationId, ac);
    runMigrationPipeline({
      ...req,
      id: migrationId,
      signal: ac.signal,
      emit: createEmitHandler(migrationId),
    })
      .then((result) => handlePipelineResult(migrationId, result))
      .catch((err) => handlePipelineError(migrationId, err));
  }

  return getMigration(migrationId)!;
}

export function restartBatch(
  batchId: string,
  creds: RestartMigrationRequest,
): { restarted: number; errors: Array<{ id: string; error: string }> } {
  const migrations = getBatchMigrations(batchId);
  const eligible = migrations.filter((m) => m.state === "failed" || m.state === "cancelled");

  const results = { restarted: 0, errors: [] as Array<{ id: string; error: string }> };

  for (const m of eligible) {
    try {
      restart(m.id, creds);
      results.restarted++;
    } catch (err) {
      results.errors.push({
        id: m.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

export function getBatch(batchId: string): BatchSummary | null {
  return getBatchSummary(batchId);
}

export function getBatchPaginated(
  batchId: string,
  params: PaginationParams,
): { summary: BatchListItem; migrations: PaginatedResult<Migration> } | null {
  const summary = getBatchListItem(batchId);
  if (!summary) return null;
  const migrations = getBatchMigrationsPaginated(batchId, params);
  return { summary, migrations };
}

export function listBatchesPaginated(params: PaginationParams): PaginatedResult<BatchListItem> {
  return listBatchItemsPaginated(params);
}

export function get(migrationId: string): Migration | null {
  return getMigration(migrationId);
}

export function list(): Migration[] {
  return listMigrations();
}

export function listPaginated(params: PaginationParams): PaginatedResult<Migration> {
  return listMigrationsPaginated(params);
}

export function events(migrationId: string, afterId?: number): MigrationEvent[] {
  return getEvents(migrationId, afterId);
}

// ── SSE ─────────────────────────────────────────────────────────────────────

export function subscribe(
  migrationId: string,
  controller: ReadableStreamDefaultController<string>,
): () => void {
  if (!sseSubscribers.has(migrationId)) {
    sseSubscribers.set(migrationId, new Set());
  }
  sseSubscribers.get(migrationId)!.add(controller);

  return () => {
    sseSubscribers.get(migrationId)?.delete(controller);
    if (sseSubscribers.get(migrationId)?.size === 0) {
      sseSubscribers.delete(migrationId);
    }
  };
}

export function subscribeGlobal(controller: ReadableStreamDefaultController<string>): () => void {
  globalSubscribers.add(controller);
  return () => {
    globalSubscribers.delete(controller);
  };
}

function broadcastEvent(migrationId: string, event: MigrationEvent): void {
  // Include SSE id: field so browsers auto-send Last-Event-ID on reconnect.
  const idLine = event.id != null ? `id: ${event.id}\n` : "";
  const data = `${idLine}data: ${JSON.stringify(event)}\n\n`;

  // Per-migration subscribers.
  const subs = sseSubscribers.get(migrationId);
  if (subs) {
    for (const ctrl of subs) {
      try {
        ctrl.enqueue(data);
      } catch {
        subs.delete(ctrl);
      }
    }
  }

  // Global subscribers (dashboard).
  for (const ctrl of globalSubscribers) {
    try {
      ctrl.enqueue(data);
    } catch {
      globalSubscribers.delete(ctrl);
    }
  }
}

// ── Crash recovery ──────────────────────────────────────────────────────────

/**
 * Attempt to reconnect to in-flight migrations that were interrupted by a
 * server restart. Only env-app auth migrations with a github_migration_id
 * are eligible — PAT and per-request app creds are lost on crash.
 *
 * Call this once during server startup, after initStore().
 */
export function recoverOrphans(): void {
  // 1. Recover running/pending env-auth migrations (reconnect to GHEC).
  const recoverable = getRecoverableMigrations();
  if (recoverable.length > 0) {
    console.log(`[manager] Attempting to recover ${recoverable.length} interrupted migration(s)`);

    for (const migration of recoverable) {
      const id = migration.id;

      // Create an AbortController so these can still be cancelled.
      const ac = new AbortController();
      controllers.set(id, ac);

      // Fire-and-forget: resume in the background.
      resumeMigration(migration, createEmitHandler(id), ac.signal)
        .then((result) => {
          handlePipelineResult(id, result);
          console.log(`[manager] Recovered migration ${id}: ${result.state}`);
        })
        .catch((err) => handlePipelineError(id, err));
    }
  }

  // 2. Re-enqueue queued env-auth migrations (haven't started yet).
  const queued = getQueuedEnvMigrations();
  if (queued.length > 0) {
    console.log(`[manager] Re-enqueuing ${queued.length} queued env-auth migration(s)`);

    for (const migration of queued) {
      const id = migration.id;

      // Reconstruct the CreateMigrationRequest from persisted options.
      const opts = migration.requestOptions ? safeParseJson(migration.requestOptions) : null;
      if (!opts) {
        console.error(`[manager] No request_options for queued migration ${id} — marking failed`);
        updateMigrationState(id, "failed", {
          failureReason: "Queued migration request options lost (internal error)",
          completedAt: new Date().toISOString(),
        });
        continue;
      }

      const req = opts as unknown as CreateMigrationRequest;
      // Fill in repo identity from DB row if missing (sourceRepo in request uses org/repo format).
      if (!req.sourceRepo) req.sourceRepo = `${migration.sourceOrg}/${migration.sourceRepo}`;
      if (!req.targetOrg) req.targetOrg = migration.targetOrg;
      if (!req.targetRepo) req.targetRepo = migration.targetRepo;

      queuedRequests.set(id, req);
    }

    // Promote queued → running as slots are available.
    drainQueue();
  }
}
