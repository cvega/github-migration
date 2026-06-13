/**
 * SQLite persistence layer for migrations and events.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { applySchema } from "$lib/server/schema";
import type {
  ActivityItem,
  ActivityKind,
  AuthMode,
  BatchListItem,
  BatchSummary,
  Counts,
  Migration,
  MigrationEvent,
  MigrationState,
  MigrationStats,
  PaginatedResult,
  PaginationParams,
  PipelineStep,
} from "$lib/types";

let db: Database;

/** Parse JSON from a DB column, returning null on malformed data. */
function safeJsonParse<T>(json: string): T | null {
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

export function initStore(dbPath: string): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  db = new Database(dbPath, { create: true });
  applySchema(db);

  // Non-recoverable orphans: mark as failed.
  // Recoverable running/pending ones (env auth with a github_migration_id) are left
  // so that recoverOrphans() in the manager can reconnect them.
  // Recoverable queued ones (env auth, no github_migration_id needed) are also left
  // so that recoverOrphans() can re-enqueue them.
  const orphaned = db
    .prepare(
      `UPDATE migrations
       SET state = 'failed',
           failure_reason = 'Server restarted during migration',
           completed_at = ?
       WHERE state IN ('queued', 'pending', 'running')
         AND id NOT LIKE 'seed-%'
         AND NOT (auth_mode IN ('env-app', 'env-pat') AND github_migration_id IS NOT NULL)
         AND NOT (auth_mode IN ('env-app', 'env-pat') AND state = 'queued')`,
    )
    .run(new Date().toISOString());
  if (orphaned.changes > 0) {
    console.log(
      `[store] Marked ${orphaned.changes} non-recoverable orphaned migration(s) as failed`,
    );
  }
}

export function getDb(): Database {
  if (!db) throw new Error("Store not initialized — call initStore() first");
  return db;
}

/** Close the database connection (for graceful shutdown). */
export function closeStore(): void {
  if (db) {
    db.close();
    console.log("[store] Database closed");
  }
}

// ── Column projections ─────────────────────────────────────────────────────

/** Explicit column list for migration queries — keeps projections in sync with the schema. */
const MIGRATION_COLS = [
  "id",
  "batch_id",
  "github_migration_id",
  "source_api_url",
  "source_org",
  "source_repo",
  "target_org",
  "target_repo",
  "state",
  "failure_reason",
  "migration_log_url",
  "warnings_count",
  "source_counts",
  "target_counts",
  "started_at",
  "completed_at",
  "elapsed_seconds",
  "pipeline_step",
  "auth_mode",
  "request_options",
  "source_size_kb",
  "target_preexisted",
  "target_repo_node_id",
].join(", ");

/** Explicit column list for event queries. */
const EVENT_COLS = "id, migration_id, event_type, phase, payload, created_at";

/**
 * Free-text search match clause. The same `$q` LIKE pattern is OR-ed across the
 * repo identity fields plus the GHEC/internal IDs and failure reason, so a
 * services engineer can paste a repo name, an `RM_…` id, or an error snippet.
 *
 * Uses a leading-wildcard LIKE, which can't use a btree index — a full table
 * scan. That's fine at this dataset's scale (single-node, low thousands of
 * rows); if it ever needs to scale, migrate to a SQLite FTS5 virtual table.
 */
const SEARCH_MATCH_CLAUSE = `(
  source_org LIKE $q ESCAPE '\\'
  OR source_repo LIKE $q ESCAPE '\\'
  OR target_org LIKE $q ESCAPE '\\'
  OR target_repo LIKE $q ESCAPE '\\'
  OR github_migration_id LIKE $q ESCAPE '\\'
  OR id LIKE $q ESCAPE '\\'
  OR failure_reason LIKE $q ESCAPE '\\'
)`;

/**
 * Build a LIKE pattern for a literal substring search, escaping the LIKE
 * wildcards (`%`, `_`) and the escape char itself so user input can't act as
 * a wildcard. Pair with `ESCAPE '\'` in the query.
 */
function likePattern(q: string): string {
  const escaped = q.replace(/[\\%_]/g, (c) => `\\${c}`);
  return `%${escaped}%`;
}

/**
 * Aggregate SELECT columns for a batch summary row: total + per-state counts +
 * earliest start. Shared by every batch-rollup query; pair with
 * `GROUP BY batch_id` and map results with {@link rowToBatchListItem}.
 */
const BATCH_AGG_COLS = `
  batch_id,
  COUNT(*) AS total,
  SUM(CASE WHEN state = 'queued' THEN 1 ELSE 0 END) AS queued,
  SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS pending,
  SUM(CASE WHEN state = 'running' THEN 1 ELSE 0 END) AS running,
  SUM(CASE WHEN state = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
  SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failed,
  SUM(CASE WHEN state = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
  MIN(started_at) AS started_at`;

/** Map a {@link BATCH_AGG_COLS} result row to a BatchListItem. */
function rowToBatchListItem(row: Record<string, unknown>): BatchListItem {
  return {
    id: row.batch_id as string,
    totalCount: row.total as number,
    queuedCount: row.queued as number,
    pendingCount: row.pending as number,
    runningCount: row.running as number,
    succeededCount: row.succeeded as number,
    failedCount: row.failed as number,
    cancelledCount: row.cancelled as number,
    startedAt: row.started_at as string,
  };
}

// ── Migrations ─────────────────────────────────────────────────────────────

export function insertMigration(m: Migration): void {
  getDb()
    .prepare(
      `INSERT INTO migrations (id, batch_id, github_migration_id, source_api_url, source_org, source_repo,
				target_org, target_repo, state, started_at, source_counts, target_counts,
				auth_mode, request_options)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      m.id,
      m.batchId,
      m.githubMigrationId,
      m.sourceApiUrl,
      m.sourceOrg,
      m.sourceRepo,
      m.targetOrg,
      m.targetRepo,
      m.state,
      m.startedAt,
      m.sourceCounts ? JSON.stringify(m.sourceCounts) : null,
      m.targetCounts ? JSON.stringify(m.targetCounts) : null,
      m.authMode,
      m.requestOptions,
    );
}

/**
 * Update migration state and optional extra fields.
 *
 * **COALESCE constraint:** The UPDATE uses `COALESCE(?, column)` for every
 * extra field, meaning `null` (the default when a field isn't provided)
 * preserves the existing DB value. This is intentional — it lets callers
 * update only the fields they care about. However, it also means you
 * **cannot** explicitly set a field back to `NULL` once it has a value.
 * If that ever becomes necessary, introduce a sentinel value or a
 * separate "clear" query.
 */
export function updateMigrationState(
  id: string,
  state: MigrationState,
  extra?: {
    githubMigrationId?: string;
    failureReason?: string;
    migrationLogUrl?: string;
    warningsCount?: number;
    sourceCounts?: Counts;
    targetCounts?: Counts;
    completedAt?: string;
    elapsedSeconds?: number;
  },
): void {
  // Fixed query — always sets every column, falling back to the existing
  // value via COALESCE when a field isn't provided. This avoids dynamic
  // SQL string construction entirely.
  getDb()
    .prepare(
      `UPDATE migrations SET
        state = ?,
        github_migration_id = COALESCE(?, github_migration_id),
        failure_reason = COALESCE(?, failure_reason),
        migration_log_url = COALESCE(?, migration_log_url),
        warnings_count = COALESCE(?, warnings_count),
        source_counts = COALESCE(?, source_counts),
        target_counts = COALESCE(?, target_counts),
        completed_at = COALESCE(?, completed_at),
        elapsed_seconds = COALESCE(?, elapsed_seconds)
      WHERE id = ?`,
    )
    .run(
      state,
      extra?.githubMigrationId ?? null,
      extra?.failureReason ?? null,
      extra?.migrationLogUrl ?? null,
      extra?.warningsCount ?? null,
      extra?.sourceCounts ? JSON.stringify(extra.sourceCounts) : null,
      extra?.targetCounts ? JSON.stringify(extra.targetCounts) : null,
      extra?.completedAt ?? null,
      extra?.elapsedSeconds ?? null,
      id,
    );
}

/** Lightweight checkpoint update — records pipeline progress for crash recovery. */
export function updateCheckpoint(
  id: string,
  step: PipelineStep,
  extras?: {
    authMode?: AuthMode;
    githubMigrationId?: string;
  },
): void {
  getDb()
    .prepare(
      `UPDATE migrations SET
        pipeline_step = ?,
        auth_mode = COALESCE(?, auth_mode),
        github_migration_id = COALESCE(?, github_migration_id)
      WHERE id = ?`,
    )
    .run(step, extras?.authMode ?? null, extras?.githubMigrationId ?? null, id);
}

/** Record the source repository's disk size (KB) once it's known. */
export function updateMigrationSourceSize(id: string, sizeKb: number): void {
  getDb().prepare("UPDATE migrations SET source_size_kb = ? WHERE id = ?").run(sizeKb, id);
}

/**
 * Persist target-repo provenance for safe-cleanup eligibility. Set during the
 * pipeline: `targetPreexisted` at preflight, `targetRepoNodeId` once the repo
 * this tool created is confirmed.
 *
 * **Write-once:** each field uses `COALESCE(column, ?)`, so once a non-null
 * value is recorded it can never be changed by this function. This is a safety
 * property, not a convenience — a restart re-runs preflight, and without
 * write-once a repo that genuinely pre-existed (`true`) could be flipped to
 * `false` if it were deleted between runs, wrongly marking it as "ours".
 */
export function updateMigrationProvenance(
  id: string,
  data: { targetPreexisted?: boolean; targetRepoNodeId?: string },
): void {
  getDb()
    .prepare(
      `UPDATE migrations SET
        target_preexisted = COALESCE(target_preexisted, ?),
        target_repo_node_id = COALESCE(target_repo_node_id, ?)
      WHERE id = ?`,
    )
    .run(
      data.targetPreexisted === undefined ? null : data.targetPreexisted ? 1 : 0,
      data.targetRepoNodeId ?? null,
      id,
    );
}

/**
 * Returns running/pending migrations that can be reconnected after a server restart:
 * env auth + a github_migration_id already assigned.
 */
export function getRecoverableMigrations(): Migration[] {
  const rows = getDb()
    .prepare(
      `SELECT ${MIGRATION_COLS} FROM migrations
       WHERE state IN ('pending', 'running')
         AND auth_mode IN ('env-app', 'env-pat')
         AND github_migration_id IS NOT NULL
         AND id NOT LIKE 'seed-%'
       ORDER BY started_at ASC`,
    )
    .all() as Record<string, unknown>[];
  return rows.map(rowToMigration);
}

/**
 * Returns queued migrations with env-based auth that can be re-enqueued
 * after a server restart. These haven't started yet (no github_migration_id)
 * but their credentials survive in env vars.
 */
export function getQueuedEnvMigrations(): Migration[] {
  const rows = getDb()
    .prepare(
      `SELECT ${MIGRATION_COLS} FROM migrations
       WHERE state = 'queued'
         AND auth_mode IN ('env-app', 'env-pat')
         AND id NOT LIKE 'seed-%'
       ORDER BY started_at ASC`,
    )
    .all() as Record<string, unknown>[];
  return rows.map(rowToMigration);
}

/**
 * Reset a failed/cancelled migration for restart.
 * Clears all transient fields and sets state to the given value.
 * Unlike updateMigrationState (which uses COALESCE and can't null-out fields),
 * this explicitly sets fields to NULL.
 */
export function resetMigration(id: string, newState: "pending" | "queued"): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `UPDATE migrations SET
        state = ?,
        github_migration_id = NULL,
        failure_reason = NULL,
        migration_log_url = NULL,
        warnings_count = 0,
        source_counts = NULL,
        target_counts = NULL,
        started_at = ?,
        completed_at = NULL,
        elapsed_seconds = NULL,
        pipeline_step = NULL
      WHERE id = ?`,
    )
    .run(newState, now, id);
}

export function getMigration(id: string): Migration | null {
  const row = getDb().prepare(`SELECT ${MIGRATION_COLS} FROM migrations WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  return rowToMigration(row);
}

export function listMigrationsPaginated(params: PaginationParams): PaginatedResult<Migration> {
  const { page, limit } = params;
  const offset = (page - 1) * limit;
  const { count: total } = getDb().prepare("SELECT COUNT(*) as count FROM migrations").get() as {
    count: number;
  };
  const rows = getDb()
    .prepare(`SELECT ${MIGRATION_COLS} FROM migrations ORDER BY started_at DESC LIMIT ? OFFSET ?`)
    .all(limit, offset) as Record<string, unknown>[];
  return {
    data: rows.map(rowToMigration),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

/**
 * Paginated free-text search over migrations (repo identity, IDs, failure
 * reason). See SEARCH_MATCH_CLAUSE for the matched fields and scaling notes.
 */
export function searchMigrationsPaginated(
  params: PaginationParams & { q: string },
): PaginatedResult<Migration> {
  const { page, limit, q } = params;
  const offset = (page - 1) * limit;
  const like = likePattern(q);
  const { count: total } = getDb()
    .prepare(`SELECT COUNT(*) AS count FROM migrations WHERE ${SEARCH_MATCH_CLAUSE}`)
    .get({ $q: like }) as { count: number };
  const rows = getDb()
    .prepare(
      `SELECT ${MIGRATION_COLS} FROM migrations
       WHERE ${SEARCH_MATCH_CLAUSE}
       ORDER BY started_at DESC LIMIT $limit OFFSET $offset`,
    )
    .all({ $q: like, $limit: limit, $offset: offset }) as Record<string, unknown>[];
  return {
    data: rows.map(rowToMigration),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

export function getActiveMigrationCount(): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) as count FROM migrations WHERE state IN ('pending', 'running')")
    .get() as { count: number };
  return row.count;
}

/**
 * Count migrations grouped by state across the entire table.
 * Backs the dashboard's section-overview tiles, which summarise the whole
 * dataset (not just the current page). A single indexed GROUP BY.
 */
export function getStateCounts(): Record<MigrationState, number> {
  const counts: Record<MigrationState, number> = {
    queued: 0,
    pending: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
  };
  const rows = getDb()
    .prepare("SELECT state, COUNT(*) AS count FROM migrations GROUP BY state")
    .all() as Array<{ state: string; count: number }>;
  for (const r of rows) {
    if (r.state in counts) counts[r.state as MigrationState] = r.count;
  }
  return counts;
}

/**
 * Aggregate analytics across all migrations for the /stats dashboard.
 * Scalar aggregates are computed in SQL; resource counts (stored as JSON)
 * are summed in a single pass over the succeeded rows.
 */
export function getMigrationStats(): MigrationStats {
  const db = getDb();

  const stateRows = db
    .prepare("SELECT state, COUNT(*) AS count FROM migrations GROUP BY state")
    .all() as Array<{ state: MigrationState; count: number }>;

  const byState: Record<MigrationState, number> = {
    queued: 0,
    pending: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
  };
  let total = 0;
  for (const r of stateRows) {
    if (r.state in byState) byState[r.state] = r.count;
    total += r.count;
  }

  const finished = byState.succeeded + byState.failed + byState.cancelled;
  const successRate = finished > 0 ? Math.round((byState.succeeded / finished) * 1000) / 10 : 0;

  const dur = db
    .prepare(
      `SELECT
        SUM(elapsed_seconds) AS total,
        AVG(elapsed_seconds) AS avg,
        MIN(elapsed_seconds) AS min,
        MAX(elapsed_seconds) AS max
      FROM migrations
      WHERE state = 'succeeded' AND elapsed_seconds IS NOT NULL`,
    )
    .get() as { total: number | null; avg: number | null; min: number | null; max: number | null };

  const sizeAgg = db
    .prepare(
      `SELECT SUM(source_size_kb) AS total, AVG(source_size_kb) AS avg
      FROM migrations
      WHERE state = 'succeeded' AND source_size_kb IS NOT NULL`,
    )
    .get() as { total: number | null; avg: number | null };

  const largest = db
    .prepare(
      `SELECT source_org || '/' || source_repo AS repo, source_size_kb AS kb
      FROM migrations
      WHERE state = 'succeeded' AND source_size_kb IS NOT NULL
      ORDER BY source_size_kb DESC LIMIT 1`,
    )
    .get() as { repo: string; kb: number } | undefined;

  const platformRows = db
    .prepare(
      `SELECT
        SUM(CASE WHEN source_api_url LIKE '%github.com%' OR source_api_url LIKE '%ghe.com%' THEN 1 ELSE 0 END) AS ghec,
        SUM(CASE WHEN source_api_url LIKE '%github.com%' OR source_api_url LIKE '%ghe.com%' THEN 0 ELSE 1 END) AS ghes
      FROM migrations`,
    )
    .get() as { ghec: number | null; ghes: number | null };

  // Per-platform success rates over finished (succeeded/failed/cancelled) migrations.
  const platformSuccessRows = db
    .prepare(
      `SELECT
        CASE WHEN source_api_url LIKE '%github.com%' OR source_api_url LIKE '%ghe.com%' THEN 'ghec' ELSE 'ghes' END AS platform,
        SUM(CASE WHEN state IN ('succeeded', 'failed', 'cancelled') THEN 1 ELSE 0 END) AS finished,
        SUM(CASE WHEN state = 'succeeded' THEN 1 ELSE 0 END) AS succeeded
      FROM migrations
      GROUP BY platform`,
    )
    .all() as Array<{ platform: "ghes" | "ghec"; finished: number; succeeded: number }>;

  const platformSuccess = {
    ghes: { finished: 0, succeeded: 0, rate: 0 },
    ghec: { finished: 0, succeeded: 0, rate: 0 },
  };
  for (const r of platformSuccessRows) {
    const entry = platformSuccess[r.platform];
    entry.finished = r.finished;
    entry.succeeded = r.succeeded;
    entry.rate = r.finished > 0 ? Math.round((r.succeeded / r.finished) * 1000) / 10 : 0;
  }

  const warningsAgg = db
    .prepare(
      `SELECT
        SUM(warnings_count) AS total,
        SUM(CASE WHEN warnings_count > 0 THEN 1 ELSE 0 END) AS with_warnings
      FROM migrations`,
    )
    .get() as { total: number | null; with_warnings: number | null };

  const fastest = db
    .prepare(
      `SELECT source_org || '/' || source_repo AS repo, elapsed_seconds AS seconds
      FROM migrations
      WHERE state = 'succeeded' AND elapsed_seconds IS NOT NULL AND elapsed_seconds > 0
      ORDER BY elapsed_seconds ASC LIMIT 1`,
    )
    .get() as { repo: string; seconds: number } | undefined;

  const slowest = db
    .prepare(
      `SELECT source_org || '/' || source_repo AS repo, elapsed_seconds AS seconds
      FROM migrations
      WHERE state = 'succeeded' AND elapsed_seconds IS NOT NULL
      ORDER BY elapsed_seconds DESC LIMIT 1`,
    )
    .get() as { repo: string; seconds: number } | undefined;

  const topOrgs = db
    .prepare(
      `SELECT source_org AS org, COUNT(*) AS count
      FROM migrations
      GROUP BY source_org
      ORDER BY count DESC, org ASC LIMIT 6`,
    )
    .all() as Array<{ org: string; count: number }>;

  const failureRows = db
    .prepare(
      `SELECT failure_reason AS reason, COUNT(*) AS count
      FROM migrations
      WHERE state = 'failed' AND failure_reason IS NOT NULL AND failure_reason != ''
      GROUP BY failure_reason
      ORDER BY count DESC, reason ASC`,
    )
    .all() as Array<{ reason: string; count: number }>;

  // Completions per UTC calendar day (substr of ISO timestamp = YYYY-MM-DD).
  const throughputRows = db
    .prepare(
      `SELECT
        substr(completed_at, 1, 10) AS date,
        SUM(CASE WHEN state = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
        SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failed
      FROM migrations
      WHERE completed_at IS NOT NULL AND state IN ('succeeded', 'failed')
      GROUP BY date
      ORDER BY date ASC`,
    )
    .all() as Array<{ date: string; succeeded: number; failed: number }>;

  // Resource totals live in the target_counts JSON blob — sum them in one pass.
  const resources: Counts = {
    commits: 0,
    branches: 0,
    tags: 0,
    issues: 0,
    pullRequests: 0,
    releases: 0,
  };
  const countRows = db
    .prepare(
      "SELECT target_counts FROM migrations WHERE state = 'succeeded' AND target_counts IS NOT NULL",
    )
    .all() as Array<{ target_counts: string }>;
  for (const r of countRows) {
    try {
      const c = JSON.parse(r.target_counts) as Partial<Counts>;
      resources.commits += c.commits ?? 0;
      resources.branches += c.branches ?? 0;
      resources.tags += c.tags ?? 0;
      resources.issues += c.issues ?? 0;
      resources.pullRequests += c.pullRequests ?? 0;
      resources.releases += c.releases ?? 0;
    } catch {
      // Skip malformed JSON rather than failing the whole stats query.
    }
  }

  const { count: batches } = db
    .prepare("SELECT COUNT(DISTINCT batch_id) AS count FROM migrations WHERE batch_id IS NOT NULL")
    .get() as { count: number };

  return {
    total,
    byState,
    finished,
    successRate,
    duration: {
      avgSeconds: dur.avg,
      totalSeconds: dur.total ?? 0,
      minSeconds: dur.min,
      maxSeconds: dur.max,
    },
    data: {
      totalKb: sizeAgg.total ?? 0,
      avgKb: sizeAgg.avg,
      largestKb: largest?.kb ?? null,
      largestRepo: largest?.repo ?? null,
    },
    resources,
    platforms: {
      ghes: platformRows.ghes ?? 0,
      ghec: platformRows.ghec ?? 0,
    },
    platformSuccess,
    warnings: {
      total: warningsAgg.total ?? 0,
      withWarnings: warningsAgg.with_warnings ?? 0,
    },
    records: {
      fastest: fastest ?? null,
      slowest: slowest ?? null,
    },
    topOrgs,
    failuresByReason: failureRows,
    throughput: throughputRows,
    batches,
  };
}

function rowToMigration(row: Record<string, unknown>): Migration {
  const id = row.id;
  if (typeof id !== "string") throw new Error("Invalid migration row: missing id");
  const sourceApiUrl = row.source_api_url;
  if (typeof sourceApiUrl !== "string")
    throw new Error(`Invalid migration row ${id}: missing source_api_url`);
  const sourceOrg = row.source_org;
  if (typeof sourceOrg !== "string")
    throw new Error(`Invalid migration row ${id}: missing source_org`);
  const sourceRepo = row.source_repo;
  if (typeof sourceRepo !== "string")
    throw new Error(`Invalid migration row ${id}: missing source_repo`);
  const targetOrg = row.target_org;
  if (typeof targetOrg !== "string")
    throw new Error(`Invalid migration row ${id}: missing target_org`);
  const targetRepo = row.target_repo;
  if (typeof targetRepo !== "string")
    throw new Error(`Invalid migration row ${id}: missing target_repo`);
  const state = row.state;
  const validStates: MigrationState[] = [
    "queued",
    "pending",
    "running",
    "succeeded",
    "failed",
    "cancelled",
  ];
  if (typeof state !== "string" || !validStates.includes(state as MigrationState)) {
    throw new Error(`Invalid migration row ${id}: invalid state "${state}"`);
  }
  const validAuthModes: AuthMode[] = ["request-pat", "request-app", "env-app", "env-pat"];
  const startedAt = row.started_at;
  if (typeof startedAt !== "string")
    throw new Error(`Invalid migration row ${id}: missing started_at`);

  return {
    id,
    batchId: typeof row.batch_id === "string" ? row.batch_id : null,
    githubMigrationId: typeof row.github_migration_id === "string" ? row.github_migration_id : null,
    sourceApiUrl,
    sourceOrg,
    sourceRepo,
    targetOrg,
    targetRepo,
    state: state as MigrationState,
    failureReason: typeof row.failure_reason === "string" ? row.failure_reason : null,
    migrationLogUrl: typeof row.migration_log_url === "string" ? row.migration_log_url : null,
    warningsCount: typeof row.warnings_count === "number" ? row.warnings_count : 0,
    sourceCounts:
      typeof row.source_counts === "string" ? safeJsonParse<Counts>(row.source_counts) : null,
    targetCounts:
      typeof row.target_counts === "string" ? safeJsonParse<Counts>(row.target_counts) : null,
    sourceSizeKb: typeof row.source_size_kb === "number" ? row.source_size_kb : null,
    startedAt,
    completedAt: typeof row.completed_at === "string" ? row.completed_at : null,
    elapsedSeconds: typeof row.elapsed_seconds === "number" ? row.elapsed_seconds : null,
    authMode:
      typeof row.auth_mode === "string" && validAuthModes.includes(row.auth_mode as AuthMode)
        ? (row.auth_mode as AuthMode)
        : null,
    requestOptions: typeof row.request_options === "string" ? row.request_options : null,
    targetPreexisted:
      row.target_preexisted === 1 ? true : row.target_preexisted === 0 ? false : null,
    targetRepoNodeId: typeof row.target_repo_node_id === "string" ? row.target_repo_node_id : null,
  };
}

// ── Batches ────────────────────────────────────────────────────────────────

export function getBatchMigrations(batchId: string): Migration[] {
  const rows = getDb()
    .prepare(`SELECT ${MIGRATION_COLS} FROM migrations WHERE batch_id = ? ORDER BY source_repo ASC`)
    .all(batchId) as Record<string, unknown>[];
  return rows.map(rowToMigration);
}

export function getBatchMigrationsPaginated(
  batchId: string,
  params: PaginationParams,
): PaginatedResult<Migration> {
  const { page, limit } = params;
  const offset = (page - 1) * limit;
  const { count: total } = getDb()
    .prepare("SELECT COUNT(*) as count FROM migrations WHERE batch_id = ?")
    .get(batchId) as { count: number };
  const rows = getDb()
    .prepare(
      `SELECT ${MIGRATION_COLS} FROM migrations WHERE batch_id = ? ORDER BY source_repo ASC LIMIT ? OFFSET ?`,
    )
    .all(batchId, limit, offset) as Record<string, unknown>[];
  return {
    data: rows.map(rowToMigration),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

export function getBatchSummary(batchId: string): BatchSummary | null {
  const item = getBatchListItem(batchId);
  if (!item) return null;
  const migrations = getBatchMigrations(batchId);
  return { ...item, migrations };
}

/** Lightweight batch info — aggregate counts only, no embedded migrations. */
export function getBatchListItem(batchId: string): BatchListItem | null {
  const row = getDb()
    .prepare(
      `SELECT ${BATCH_AGG_COLS}
       FROM migrations WHERE batch_id = ?
       GROUP BY batch_id`,
    )
    .get(batchId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToBatchListItem(row);
}

export function listBatchItemsPaginated(params: PaginationParams): PaginatedResult<BatchListItem> {
  const { page, limit } = params;
  const offset = (page - 1) * limit;
  const { count: total } = getDb()
    .prepare("SELECT COUNT(DISTINCT batch_id) as count FROM migrations WHERE batch_id IS NOT NULL")
    .get() as { count: number };
  const rows = getDb()
    .prepare(
      `SELECT ${BATCH_AGG_COLS}
      FROM migrations
      WHERE batch_id IS NOT NULL
      GROUP BY batch_id
      ORDER BY MIN(started_at) DESC
      LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as Record<string, unknown>[];
  return {
    data: rows.map(rowToBatchListItem),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

/**
 * Paginated batch search: returns batches that contain at least one migration
 * matching the query. The aggregate counts still reflect the whole batch (not
 * just matching repos) so the rollup bar stays accurate.
 */
export function searchBatchItemsPaginated(
  params: PaginationParams & { q: string },
): PaginatedResult<BatchListItem> {
  const { page, limit, q } = params;
  const offset = (page - 1) * limit;
  const like = likePattern(q);
  // Batches with ≥1 matching migration. Embedded in both the count and the
  // page query; `$q` is bound once per statement.
  const matchingBatchIds = `
    SELECT DISTINCT batch_id FROM migrations
    WHERE batch_id IS NOT NULL AND ${SEARCH_MATCH_CLAUSE}`;
  const { count: total } = getDb()
    .prepare(`SELECT COUNT(*) AS count FROM (${matchingBatchIds})`)
    .get({ $q: like }) as { count: number };
  const rows = getDb()
    .prepare(
      `SELECT ${BATCH_AGG_COLS}
      FROM migrations
      WHERE batch_id IN (${matchingBatchIds})
      GROUP BY batch_id
      ORDER BY MIN(started_at) DESC
      LIMIT $limit OFFSET $offset`,
    )
    .all({ $q: like, $limit: limit, $offset: offset }) as Record<string, unknown>[];
  return {
    data: rows.map(rowToBatchListItem),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

// ── Events ─────────────────────────────────────────────────────────────────

export function insertEvent(event: MigrationEvent): number {
  const db = getDb();
  db.prepare(
    `INSERT INTO events (migration_id, event_type, phase, payload, created_at)
			 VALUES (?, ?, ?, ?, ?)`,
  ).run(
    event.migrationId,
    event.eventType,
    event.phase,
    JSON.stringify(event.payload),
    event.createdAt,
  );
  // Return the auto-increment row ID so callers can include it in SSE id: fields.
  return (db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
}

const VALID_EVENT_TYPES = new Set([
  "banner",
  "step",
  "phase_change",
  "milestone",
  "snapshot",
  "complete",
  "failure",
  "restart",
]);

export function getEvents(migrationId: string, afterId?: number): MigrationEvent[] {
  const rows =
    afterId !== undefined
      ? (getDb()
          .prepare(
            `SELECT ${EVENT_COLS} FROM events WHERE migration_id = ? AND id > ? ORDER BY id ASC`,
          )
          .all(migrationId, afterId) as Record<string, unknown>[])
      : (getDb()
          .prepare(`SELECT ${EVENT_COLS} FROM events WHERE migration_id = ? ORDER BY id ASC`)
          .all(migrationId) as Record<string, unknown>[]);
  return rows
    .filter((row) => VALID_EVENT_TYPES.has(row.event_type as string))
    .map(
      (row) =>
        ({
          id: row.id as number,
          migrationId: row.migration_id as string,
          eventType: row.event_type,
          phase: row.phase ?? null,
          payload: safeJsonParse(row.payload as string) ?? {},
          createdAt: row.created_at as string,
        }) as MigrationEvent,
    );
}

/** Event types surfaced in the recent-activity notification feed. */
const ACTIVITY_EVENT_TYPES = ["complete", "failure", "restart", "banner"] as const;

/** Map a stored event type to its notification-feed kind. */
function activityKind(eventType: string): ActivityKind {
  switch (eventType) {
    case "complete":
      return "succeeded";
    case "failure":
      return "failed";
    case "restart":
      return "restarted";
    default:
      return "notice";
  }
}

/** Derive a human-readable detail line from a lifecycle event payload. */
function activitySummary(eventType: string, payload: Record<string, unknown>): string {
  if (eventType === "failure") {
    const detail = payload.detail as { failureReason?: string } | undefined;
    return (
      (typeof payload.error === "string" && payload.error) ||
      detail?.failureReason ||
      "Migration failed"
    );
  }
  if (eventType === "restart" || eventType === "banner") {
    return typeof payload.message === "string" ? payload.message : "";
  }
  return ""; // complete — the repo + "succeeded" kind says enough.
}

/**
 * Most recent lifecycle events across all migrations, newest first, joined
 * with each migration's repo identity for the notification feed.
 */
export function getRecentActivity(limit = 20): ActivityItem[] {
  const placeholders = ACTIVITY_EVENT_TYPES.map(() => "?").join(", ");
  const rows = getDb()
    .prepare(
      `SELECT e.id AS id, e.migration_id AS migration_id, e.event_type AS event_type,
              e.payload AS payload, e.created_at AS created_at,
              m.source_org AS source_org, m.source_repo AS source_repo
       FROM events e
       JOIN migrations m ON m.id = e.migration_id
       WHERE e.event_type IN (${placeholders})
       ORDER BY e.id DESC
       LIMIT ?`,
    )
    .all(...ACTIVITY_EVENT_TYPES, limit) as Record<string, unknown>[];
  return rows.map((row) => {
    const eventType = row.event_type as string;
    const payload = safeJsonParse<Record<string, unknown>>(row.payload as string) ?? {};
    return {
      id: row.id as number,
      migrationId: row.migration_id as string,
      kind: activityKind(eventType),
      repo: `${row.source_org as string}/${row.source_repo as string}`,
      summary: activitySummary(eventType, payload),
      createdAt: row.created_at as string,
    };
  });
}

// ── Queue ──────────────────────────────────────────────────────────────────

/** Return the oldest queued migration (FIFO across all batches), or null. */
export function getNextQueuedMigration(): Migration | null {
  const row = getDb()
    .prepare(
      `SELECT ${MIGRATION_COLS} FROM migrations WHERE state = 'queued' ORDER BY started_at ASC LIMIT 1`,
    )
    .get() as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToMigration(row);
}
