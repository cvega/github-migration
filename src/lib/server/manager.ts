/**
 * Concurrency manager — semaphore(10), abort controllers, SSE broadcast.
 * This is the top-level entry point that wires migration.ts → store.ts → SSE.
 */
// bun:sqlite built-in UUIDv7 — time-sortable, zero deps
import type {
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
} from "$lib/types";
import { resumeMigration, runMigrationPipeline } from "./migration";
import {
  getActiveMigrationCount,
  getBatchListItem,
  getBatchMigrations,
  getBatchMigrationsPaginated,
  getBatchSummary,
  getEvents,
  getMigration,
  getRecoverableMigrations,
  insertEvent,
  insertMigration,
  listBatchItemsPaginated,
  listMigrations,
  listMigrationsPaginated,
  updateMigrationState,
} from "./store";

/** GitHub-imposed concurrent migration limit per organization. */
const MAX_CONCURRENT = 10;

/** Active migration abort controllers, keyed by migration ID. */
const controllers = new Map<string, AbortController>();

/** SSE subscribers: migrationId → Set<writable stream controllers>. */
const sseSubscribers = new Map<string, Set<ReadableStreamDefaultController<string>>>();

/** Global subscribers (dashboard — receive events for ALL migrations). */
const globalSubscribers = new Set<ReadableStreamDefaultController<string>>();

// ── Public API ──────────────────────────────────────────────────────────────

export function start(req: CreateMigrationRequest, batchId?: string): Migration {
  const active = getActiveMigrationCount();
  if (active >= MAX_CONCURRENT) {
    throw new Error(
      `Concurrency limit reached (${MAX_CONCURRENT}). Wait for a running migration to complete.`,
    );
  }

  const id = Bun.randomUUIDv7();
  const now = new Date().toISOString();

  // Determine source org/repo from the request.
  const parts = req.sourceRepo.split("/");
  const sourceOrg = parts.length > 1 ? parts[0] : req.sourceRepo;
  const sourceRepoName = parts.length > 1 ? parts[1] : req.sourceRepo;

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
  };

  insertMigration(migration);

  // Create an AbortController for cancellation.
  const ac = new AbortController();
  controllers.set(id, ac);

  // Fire-and-forget: run the pipeline in the background.
  runMigrationPipeline({
    ...req,
    id,
    signal: ac.signal,
    emit: (event: MigrationEvent) => {
      // Persist event.
      insertEvent(event);

      // Update migration state from terminal events immediately so the
      // DB reflects the new state before the SSE broadcast triggers a
      // client-side refresh.  The .then() handler below may also update
      // state with richer data from the pipeline result — this is
      // intentionally idempotent (two UPDATEs to the same row are safe
      // and ensure the dashboard never misses a transition).
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
        // Keep state as 'running' once pipeline starts, and propagate source counts if present.
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
        // Propagate live data from snapshots to the migration record
        // so the DB stays current during active migrations.
        const snap = event.payload.progress?.current;
        const srcCounts = event.payload.sourceCounts;
        if (snap) {
          const extra: Parameters<typeof updateMigrationState>[2] = {};
          if (snap.warningsCount > 0) extra.warningsCount = snap.warningsCount;
          if (snap.migrationLogUrl) extra.migrationLogUrl = snap.migrationLogUrl;
          // Update target counts from the live snapshot.
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

      // Broadcast to SSE subscribers.
      broadcastEvent(id, event);
    },
  })
    .then((result) => {
      // Update final state from pipeline result.
      updateMigrationState(id, result.state, {
        githubMigrationId: result.githubMigrationId ?? undefined,
        sourceCounts: result.sourceCounts ?? undefined,
        targetCounts: result.targetCounts ?? undefined,
        warningsCount: result.warningsCount,
        completedAt: result.completedAt ?? undefined,
        elapsedSeconds: result.elapsedSeconds ?? undefined,
        failureReason: result.failureReason ?? undefined,
        migrationLogUrl: result.migrationLogUrl ?? undefined,
      });
      controllers.delete(id);
    })
    .catch((err) => {
      console.error(`Migration ${id} crashed:`, err);
      updateMigrationState(id, "failed", {
        failureReason: err instanceof Error ? err.message : String(err),
        completedAt: new Date().toISOString(),
      });
      controllers.delete(id);
    });

  return migration;
}

export function cancel(migrationId: string): boolean {
  const ac = controllers.get(migrationId);
  if (!ac) return false;
  ac.abort();
  controllers.delete(migrationId);
  updateMigrationState(migrationId, "cancelled", {
    completedAt: new Date().toISOString(),
  });
  return true;
}

// ── Batch operations ────────────────────────────────────────────────────────

export function startBatch(req: BatchMigrationRequest): BatchSummary {
  const batchId = Bun.randomUUIDv7();
  const migrations: Migration[] = [];
  const skippedRepos: string[] = [];

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
    };

    try {
      const migration = start(migReq, batchId);
      migrations.push(migration);
    } catch {
      // Hit concurrency limit — collect remaining repos as skipped.
      skippedRepos.push(trimmed);
    }
  }

  if (migrations.length === 0 && skippedRepos.length > 0) {
    throw new Error(
      `Concurrency limit reached (${MAX_CONCURRENT}). All ${skippedRepos.length} repos were skipped.`,
    );
  }

  return {
    id: batchId,
    totalCount: migrations.length,
    pendingCount: migrations.filter((m) => m.state === "pending").length,
    runningCount: migrations.filter((m) => m.state === "running").length,
    succeededCount: 0,
    failedCount: 0,
    cancelledCount: 0,
    startedAt: migrations[0]?.startedAt || new Date().toISOString(),
    migrations,
    ...(skippedRepos.length > 0 ? { skippedRepos } : {}),
  };
}

export function cancelBatch(batchId: string): number {
  const migrations = getBatchMigrations(batchId);
  let cancelledCount = 0;
  for (const m of migrations) {
    if (m.state === "pending" || m.state === "running") {
      if (cancel(m.id)) cancelledCount++;
    }
  }
  return cancelledCount;
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
  const data = `data: ${JSON.stringify(event)}\n\n`;

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
  const recoverable = getRecoverableMigrations();
  if (recoverable.length === 0) return;

  console.log(`[manager] Attempting to recover ${recoverable.length} interrupted migration(s)`);

  for (const migration of recoverable) {
    const id = migration.id;

    // Create an AbortController so these can still be cancelled.
    const ac = new AbortController();
    controllers.set(id, ac);

    // Emit callback — same wiring as start().
    const emit = (event: MigrationEvent) => {
      insertEvent(event);

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
      } else if (event.eventType === "snapshot") {
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

      broadcastEvent(id, event);
    };

    // Fire-and-forget: resume in the background.
    resumeMigration(migration, emit)
      .then((result) => {
        updateMigrationState(id, result.state, {
          githubMigrationId: result.githubMigrationId ?? undefined,
          sourceCounts: result.sourceCounts ?? undefined,
          targetCounts: result.targetCounts ?? undefined,
          warningsCount: result.warningsCount,
          completedAt: result.completedAt ?? undefined,
          elapsedSeconds: result.elapsedSeconds ?? undefined,
          failureReason: result.failureReason ?? undefined,
          migrationLogUrl: result.migrationLogUrl ?? undefined,
        });
        controllers.delete(id);
        console.log(`[manager] Recovered migration ${id}: ${result.state}`);
      })
      .catch((err) => {
        console.error(`[manager] Recovery failed for ${id}:`, err);
        updateMigrationState(id, "failed", {
          failureReason: err instanceof Error ? err.message : String(err),
          completedAt: new Date().toISOString(),
        });
        controllers.delete(id);
      });
  }
}
