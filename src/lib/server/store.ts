/**
 * SQLite persistence layer for migrations and events.
 */
import { Database } from "bun:sqlite";
import type { SQLQueryBindings } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  Migration,
  MigrationEvent,
  MigrationState,
  Counts,
  BatchSummary,
  BatchListItem,
  PaginatedResult,
  PaginationParams,
} from "$lib/types";

let db: Database;

export function initStore(dbPath: string): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  db = new Database(dbPath, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");

  db.run(`
		CREATE TABLE IF NOT EXISTS migrations (
			id TEXT PRIMARY KEY,
			batch_id TEXT,
			github_migration_id TEXT,
			source_api_url TEXT NOT NULL,
			source_org TEXT NOT NULL,
			source_repo TEXT NOT NULL,
			target_org TEXT NOT NULL,
			target_repo TEXT NOT NULL,
			state TEXT NOT NULL DEFAULT 'pending',
			failure_reason TEXT,
			migration_log_url TEXT,
			warnings_count INTEGER NOT NULL DEFAULT 0,
			source_counts TEXT,
			target_counts TEXT,
			started_at TEXT NOT NULL,
			completed_at TEXT,
			elapsed_seconds REAL
		);

		CREATE TABLE IF NOT EXISTS events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			migration_id TEXT NOT NULL REFERENCES migrations(id),
			event_type TEXT NOT NULL,
			phase TEXT,
			payload TEXT NOT NULL DEFAULT '{}',
			created_at TEXT NOT NULL
		);

		CREATE INDEX IF NOT EXISTS idx_events_migration_id ON events(migration_id);
		CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(migration_id, created_at);
	`);

  // Schema migration: add batch_id column if missing (for DBs created before batch support).
  const cols = db.prepare("PRAGMA table_info(migrations)").all() as Array<{
    name: string;
  }>;
  if (!cols.some((c) => c.name === "batch_id")) {
    db.run("ALTER TABLE migrations ADD COLUMN batch_id TEXT");
  }

  // Mark orphaned pending/running migrations as failed (server restarted mid-migration).
  // Seed data (id LIKE 'seed-%') is excluded so dev/test fixtures survive restarts.
  const orphaned = db
    .prepare(
      "UPDATE migrations SET state = 'failed', failure_reason = 'Server restarted during migration', completed_at = ? WHERE state IN ('pending', 'running') AND id NOT LIKE 'seed-%'",
    )
    .run(new Date().toISOString());
  if (orphaned.changes > 0) {
    console.log(
      `[store] Marked ${orphaned.changes} orphaned migration(s) as failed`,
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

// ── Migrations ─────────────────────────────────────────────────────────────

export function insertMigration(m: Migration): void {
  getDb()
    .prepare(
      `INSERT INTO migrations (id, batch_id, github_migration_id, source_api_url, source_org, source_repo,
				target_org, target_repo, state, started_at, source_counts, target_counts)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    );
}

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

export function getMigration(id: string): Migration | null {
  const row = getDb()
    .prepare("SELECT * FROM migrations WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToMigration(row);
}

export function listMigrations(): Migration[] {
  const rows = getDb()
    .prepare("SELECT * FROM migrations ORDER BY started_at DESC")
    .all() as Record<string, unknown>[];
  return rows.map(rowToMigration);
}

export function listMigrationsPaginated(
  params: PaginationParams,
): PaginatedResult<Migration> {
  const { page, limit } = params;
  const offset = (page - 1) * limit;
  const { count: total } = getDb()
    .prepare("SELECT COUNT(*) as count FROM migrations")
    .get() as { count: number };
  const rows = getDb()
    .prepare(
      "SELECT * FROM migrations ORDER BY started_at DESC LIMIT ? OFFSET ?",
    )
    .all(limit, offset) as Record<string, unknown>[];
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
    .prepare(
      "SELECT COUNT(*) as count FROM migrations WHERE state IN ('pending', 'running')",
    )
    .get() as { count: number };
  return row.count;
}

function rowToMigration(row: Record<string, unknown>): Migration {
  const id = row.id;
  if (typeof id !== "string")
    throw new Error("Invalid migration row: missing id");
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
    "pending",
    "running",
    "succeeded",
    "failed",
    "cancelled",
  ];
  if (
    typeof state !== "string" ||
    !validStates.includes(state as MigrationState)
  ) {
    throw new Error(`Invalid migration row ${id}: invalid state "${state}"`);
  }
  const startedAt = row.started_at;
  if (typeof startedAt !== "string")
    throw new Error(`Invalid migration row ${id}: missing started_at`);

  return {
    id,
    batchId: typeof row.batch_id === "string" ? row.batch_id : null,
    githubMigrationId:
      typeof row.github_migration_id === "string"
        ? row.github_migration_id
        : null,
    sourceApiUrl,
    sourceOrg,
    sourceRepo,
    targetOrg,
    targetRepo,
    state: state as MigrationState,
    failureReason:
      typeof row.failure_reason === "string" ? row.failure_reason : null,
    migrationLogUrl:
      typeof row.migration_log_url === "string" ? row.migration_log_url : null,
    warningsCount:
      typeof row.warnings_count === "number" ? row.warnings_count : 0,
    sourceCounts:
      typeof row.source_counts === "string"
        ? JSON.parse(row.source_counts)
        : null,
    targetCounts:
      typeof row.target_counts === "string"
        ? JSON.parse(row.target_counts)
        : null,
    startedAt,
    completedAt: typeof row.completed_at === "string" ? row.completed_at : null,
    elapsedSeconds:
      typeof row.elapsed_seconds === "number" ? row.elapsed_seconds : null,
  };
}

// ── Batches ────────────────────────────────────────────────────────────────

export function getBatchMigrations(batchId: string): Migration[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM migrations WHERE batch_id = ? ORDER BY source_repo ASC",
    )
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
      "SELECT * FROM migrations WHERE batch_id = ? ORDER BY source_repo ASC LIMIT ? OFFSET ?",
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
  // Fetch all migrations once and derive counts in JS to avoid a second query.
  const migrations = getBatchMigrations(batchId);
  if (migrations.length === 0) return null;

  let pending = 0,
    running = 0,
    succeeded = 0,
    failed = 0,
    cancelled = 0;
  let startedAt = migrations[0].startedAt;
  for (const m of migrations) {
    switch (m.state) {
      case "pending":
        pending++;
        break;
      case "running":
        running++;
        break;
      case "succeeded":
        succeeded++;
        break;
      case "failed":
        failed++;
        break;
      case "cancelled":
        cancelled++;
        break;
    }
    if (m.startedAt < startedAt) startedAt = m.startedAt;
  }

  return {
    id: batchId,
    totalCount: migrations.length,
    pendingCount: pending,
    runningCount: running,
    succeededCount: succeeded,
    failedCount: failed,
    cancelledCount: cancelled,
    startedAt,
    migrations,
  };
}

/** Lightweight batch info — aggregate counts only, no embedded migrations. */
export function getBatchListItem(batchId: string): BatchListItem | null {
  const row = getDb()
    .prepare(
      `
			SELECT
				batch_id,
				COUNT(*) AS total,
				SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS pending,
				SUM(CASE WHEN state = 'running' THEN 1 ELSE 0 END) AS running,
				SUM(CASE WHEN state = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
				SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failed,
				SUM(CASE WHEN state = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
				MIN(started_at) AS started_at
			FROM migrations WHERE batch_id = ?
			GROUP BY batch_id
		`,
    )
    .get(batchId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: batchId,
    totalCount: row.total as number,
    pendingCount: row.pending as number,
    runningCount: row.running as number,
    succeededCount: row.succeeded as number,
    failedCount: row.failed as number,
    cancelledCount: row.cancelled as number,
    startedAt: row.started_at as string,
  };
}

export function listBatchIds(): string[] {
  const rows = getDb()
    .prepare(
      `
			SELECT batch_id, MIN(started_at) AS first_started
			FROM migrations WHERE batch_id IS NOT NULL
			GROUP BY batch_id
			ORDER BY first_started DESC
		`,
    )
    .all() as Record<string, unknown>[];
  return rows.map((r) => r.batch_id as string);
}

export function listBatchIdsPaginated(
  params: PaginationParams,
): PaginatedResult<string> {
  const { page, limit } = params;
  const offset = (page - 1) * limit;
  const { count: total } = getDb()
    .prepare(
      "SELECT COUNT(DISTINCT batch_id) as count FROM migrations WHERE batch_id IS NOT NULL",
    )
    .get() as { count: number };
  const rows = getDb()
    .prepare(
      `
			SELECT batch_id, MIN(started_at) as first_started
			FROM migrations WHERE batch_id IS NOT NULL
			GROUP BY batch_id
			ORDER BY first_started DESC
			LIMIT ? OFFSET ?
		`,
    )
    .all(limit, offset) as Record<string, unknown>[];
  return {
    data: rows.map((r) => r.batch_id as string),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

// ── Events ─────────────────────────────────────────────────────────────────

export function insertEvent(event: MigrationEvent): void {
  getDb()
    .prepare(
      `INSERT INTO events (migration_id, event_type, phase, payload, created_at)
			 VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      event.migrationId,
      event.eventType,
      event.phase,
      JSON.stringify(event.payload),
      event.createdAt,
    );
}

const VALID_EVENT_TYPES = new Set([
  "banner",
  "step",
  "phase_change",
  "milestone",
  "snapshot",
  "complete",
  "failure",
]);

export function getEvents(
  migrationId: string,
  afterId?: number,
): MigrationEvent[] {
  let query = "SELECT * FROM events WHERE migration_id = ?";
  const params: SQLQueryBindings[] = [migrationId];

  if (afterId !== undefined) {
    query += " AND id > ?";
    params.push(afterId);
  }

  query += " ORDER BY id ASC";

  const rows = getDb()
    .prepare(query)
    .all(...params) as Record<string, unknown>[];
  return rows
    .filter((row) => VALID_EVENT_TYPES.has(row.event_type as string))
    .map(
      (row) =>
        ({
          id: row.id as number,
          migrationId: row.migration_id as string,
          eventType: row.event_type,
          phase: row.phase ?? null,
          payload: JSON.parse(row.payload as string),
          createdAt: row.created_at as string,
        }) as MigrationEvent,
    );
}
