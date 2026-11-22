/**
 * The Migrate domain's persistence contribution: table DDL, schema upgrades,
 * retention, and the first phase of startup recovery. Restart classification
 * fails provably local interruptions, quarantines ambiguous remote writes, and
 * leaves durable server-auth checkpoints for the manager to resume.
 *
 * Registered via `$lib/server/schemas` so {@link initStore} applies it at
 * startup. The query functions themselves live in `./store`.
 */
import type { Database } from "bun:sqlite";
import {
  ACTIVE_MIGRATION_STATES,
  EXECUTING_MIGRATION_STATES,
  FINISHED_MIGRATION_STATES,
  migrationStatesSql,
} from "$lib/migration-state";
import { GITLAB_GHES_PAUSE_REASON } from "$lib/migration-target";
import {
  addColumnIfMissing,
  type DomainStore,
  type DurableTableContract,
} from "$lib/server/core/db";
import { SOURCE_PROVIDERS } from "$lib/source-provider";
import { MIGRATION_COLS, PAUSED_GITLAB_ROUTE_SQL } from "./columns";

export const MIGRATE_DURABLE_TABLES = [
  {
    name: "app_schema_versions",
    purpose: "Per-domain schema versions",
    notes: "Supports idempotent startup upgrades",
  },
  {
    name: "migrations",
    purpose: "One row per repository migration",
    notes:
      "Includes batch ID, source provider, native and GitHub checkpoints, state, pipeline step, auth mode, request options, counts, and timestamps",
  },
  {
    name: "events",
    purpose: "Append-only migration event log",
    notes: "Replayed for SSE catch-up",
  },
  {
    name: "ghes_import_jobs",
    purpose: "Durable exporter-to-GHES import state",
    notes:
      "Stores exporter identity, archive path and hash, ghe-migrator GUID, source lock state, phase, and failure reason",
  },
  {
    name: "migration_batch_items",
    purpose: "Durable batch membership",
    notes: "Enforces unique source and target identities per batch",
  },
  {
    name: "migration_identity_mappings",
    purpose: "Approved source-to-target identity decisions",
    notes: "Scoped by target API, organization, source kind, and source identity",
  },
] as const satisfies readonly DurableTableContract[];

const MIGRATE_DDL = `
  CREATE TABLE IF NOT EXISTS app_schema_versions (
    domain TEXT PRIMARY KEY,
    version INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS migrations (
    id TEXT PRIMARY KEY,
    batch_id TEXT,
    github_migration_id TEXT,
    source_export_id TEXT,
    source_provider TEXT NOT NULL DEFAULT 'github',
    source_api_url TEXT NOT NULL,
    target_profile_id TEXT NOT NULL DEFAULT 'ghec',
    target_platform TEXT NOT NULL DEFAULT 'ghec',
    target_api_url TEXT NOT NULL DEFAULT 'https://api.github.com',
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
    elapsed_seconds REAL,
    pipeline_step TEXT,
    auth_mode TEXT,
    request_options TEXT,
    source_size_kb INTEGER
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    migration_id TEXT NOT NULL REFERENCES migrations(id),
    event_type TEXT NOT NULL,
    phase TEXT,
    payload TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ghes_import_jobs (
    id TEXT PRIMARY KEY,
    migration_id TEXT NOT NULL UNIQUE REFERENCES migrations(id) ON DELETE CASCADE,
    phase TEXT NOT NULL DEFAULT 'pending',
    exporter_job_id TEXT,
    archive_path TEXT,
    archive_sha256 TEXT,
    ghes_import_id TEXT,
    source_was_archived INTEGER,
    failure_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS migration_identity_mappings (
    target_api_url TEXT NOT NULL,
    target_org TEXT NOT NULL COLLATE NOCASE,
    source_kind TEXT NOT NULL,
    source_identity TEXT NOT NULL,
    target_login TEXT,
    status TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (target_api_url, target_org, source_kind, source_identity)
  );

  CREATE INDEX IF NOT EXISTS idx_events_migration_id ON events(migration_id);
  CREATE INDEX IF NOT EXISTS idx_events_migration_id_id ON events(migration_id, id);
  CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(migration_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_migrations_state ON migrations(state);
  CREATE INDEX IF NOT EXISTS idx_migrations_batch_id ON migrations(batch_id);
  CREATE INDEX IF NOT EXISTS idx_migrations_started_at ON migrations(started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_migrations_completed_at ON migrations(completed_at DESC);
  CREATE INDEX IF NOT EXISTS idx_ghes_import_jobs_phase ON ghes_import_jobs(phase);
`;

const BATCH_ITEM_DDL = `
  CREATE TABLE IF NOT EXISTS migration_batch_items (
    batch_id TEXT NOT NULL,
    source_org TEXT NOT NULL COLLATE NOCASE,
    source_repo TEXT NOT NULL COLLATE NOCASE,
    target_repo TEXT NOT NULL COLLATE NOCASE,
    migration_id TEXT NOT NULL UNIQUE REFERENCES migrations(id) ON DELETE CASCADE,
    PRIMARY KEY (batch_id, source_org, source_repo, target_repo)
  );
`;

function migrateProviderSchema(db: Database): void {
  const row = db
    .prepare("SELECT version FROM app_schema_versions WHERE domain = 'migrate'")
    .get() as { version: number } | null;
  if ((row?.version ?? 0) >= 1) return;

  db.run("PRAGMA foreign_keys = OFF");
  try {
    db.transaction(() => {
      const table = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'migrations'")
        .get() as { sql: string } | null;
      const hasClosedProviderConstraint =
        table?.sql != null && /CHECK\s*\([\s\S]*source_provider/i.test(table.sql);

      if (hasClosedProviderConstraint) {
        db.run(`CREATE TABLE migrations_next (
          id TEXT PRIMARY KEY,
          batch_id TEXT,
          github_migration_id TEXT,
          source_export_id TEXT,
          source_provider TEXT NOT NULL DEFAULT 'github',
          source_api_url TEXT NOT NULL,
          target_profile_id TEXT NOT NULL DEFAULT 'ghec',
          target_platform TEXT NOT NULL DEFAULT 'ghec',
          target_api_url TEXT NOT NULL DEFAULT 'https://api.github.com',
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
          elapsed_seconds REAL,
          pipeline_step TEXT,
          auth_mode TEXT,
          request_options TEXT,
          source_size_kb INTEGER
        )`);
        db.run(
          `INSERT INTO migrations_next (${MIGRATION_COLS}) SELECT ${MIGRATION_COLS} FROM migrations`,
        );
        db.run("DROP TABLE migrations");
        db.run("ALTER TABLE migrations_next RENAME TO migrations");
      }

      db.prepare(
        `INSERT INTO app_schema_versions (domain, version) VALUES ('migrate', 1)
         ON CONFLICT(domain) DO UPDATE SET version = excluded.version`,
      ).run();
    })();
  } finally {
    db.run("PRAGMA foreign_keys = ON");
  }

  const violations = db.prepare("PRAGMA foreign_key_check").all();
  if (violations.length > 0) {
    throw new Error("Migration provider schema migration left invalid foreign keys");
  }
}

function migrateBatchItemSchema(db: Database): void {
  const row = db
    .prepare("SELECT version FROM app_schema_versions WHERE domain = 'migrate'")
    .get() as { version: number } | null;
  if ((row?.version ?? 0) >= 3) return;

  db.transaction(() => {
    db.run(BATCH_ITEM_DDL);
    db.run(`INSERT OR IGNORE INTO migration_batch_items
      (batch_id, source_org, source_repo, target_repo, migration_id)
      SELECT batch_id, source_org, source_repo, target_repo, id
      FROM migrations WHERE batch_id IS NOT NULL
      ORDER BY started_at, id`);
    db.prepare(
      `INSERT INTO app_schema_versions (domain, version) VALUES ('migrate', 3)
       ON CONFLICT(domain) DO UPDATE SET version = excluded.version`,
    ).run();
  })();
}

function migrateBitbucketCheckpointSchema(db: Database): void {
  const row = db
    .prepare("SELECT version FROM app_schema_versions WHERE domain = 'migrate'")
    .get() as { version: number } | null;
  if ((row?.version ?? 0) >= 4) return;

  db.transaction(() => {
    addColumnIfMissing(db, "migrations", "source_export_id", "TEXT");
    db.prepare(
      `INSERT INTO app_schema_versions (domain, version) VALUES ('migrate', 4)
       ON CONFLICT(domain) DO UPDATE SET version = excluded.version`,
    ).run();
  })();
}

function migrateTargetProfileSchema(db: Database): void {
  const row = db
    .prepare("SELECT version FROM app_schema_versions WHERE domain = 'migrate'")
    .get() as { version: number } | null;
  if ((row?.version ?? 0) >= 5) return;

  db.transaction(() => {
    addColumnIfMissing(db, "migrations", "target_profile_id", "TEXT NOT NULL DEFAULT 'ghec'");
    addColumnIfMissing(db, "migrations", "target_platform", "TEXT NOT NULL DEFAULT 'ghec'");
    addColumnIfMissing(
      db,
      "migrations",
      "target_api_url",
      "TEXT NOT NULL DEFAULT 'https://api.github.com'",
    );
    db.prepare(
      `INSERT INTO app_schema_versions (domain, version) VALUES ('migrate', 5)
       ON CONFLICT(domain) DO UPDATE SET version = excluded.version`,
    ).run();
  })();
}

function migrateGhesImportJobSchema(db: Database): void {
  const row = db
    .prepare("SELECT version FROM app_schema_versions WHERE domain = 'migrate'")
    .get() as { version: number } | null;
  if ((row?.version ?? 0) >= 6) return;

  db.prepare(
    `INSERT INTO app_schema_versions (domain, version) VALUES ('migrate', 6)
     ON CONFLICT(domain) DO UPDATE SET version = excluded.version`,
  ).run();
}

function migrateGhesSourceLockSchema(db: Database): void {
  const row = db
    .prepare("SELECT version FROM app_schema_versions WHERE domain = 'migrate'")
    .get() as { version: number } | null;
  if ((row?.version ?? 0) >= 7) return;

  db.transaction(() => {
    addColumnIfMissing(db, "ghes_import_jobs", "source_was_archived", "INTEGER");
    db.prepare(
      `INSERT INTO app_schema_versions (domain, version) VALUES ('migrate', 7)
       ON CONFLICT(domain) DO UPDATE SET version = excluded.version`,
    ).run();
  })();
}

/**
 * On startup, fail migrations that never crossed a remote side-effect boundary
 * and quarantine ambiguous remote starts/cancellations for operator review.
 * Recoverable env-auth runs (a running/pending one with a GitHub migration ID
 * or a durable native export checkpoint, or a queued one) are left for the
 * manager. The native checkpoint is GitLab's acknowledged-export sentinel or
 * Bitbucket's export ID. A `source_export` step without that marker is an
 * ambiguous provider write and therefore requires reconciliation.
 */
export function recoverInterruptedMigrations(db: Database, nowMs: number = Date.now()): void {
  const now = new Date(nowMs).toISOString();
  // Classify paused work before normal recovery or retention can consume its checkpoints.
  db.prepare(
    `UPDATE migrations
     SET state = CASE WHEN state = 'queued' AND github_migration_id IS NULL
       AND source_export_id IS NULL AND pipeline_step IS NULL
       AND NOT EXISTS (SELECT 1 FROM ghes_import_jobs WHERE migration_id = migrations.id)
       THEN 'failed' ELSE 'reconciliation_required' END,
       failure_reason = ?, completed_at = ?
     WHERE state IN (${migrationStatesSql(ACTIVE_MIGRATION_STATES)})
       AND id NOT LIKE 'seed-%' AND ${PAUSED_GITLAB_ROUTE_SQL}`,
  ).run(GITLAB_GHES_PAUSE_REASON, now);
  const providerBindings: Record<string, string> = { $now: now };
  const providerPlaceholders = SOURCE_PROVIDERS.map((provider, index) => {
    const name = `$provider_${index}`;
    providerBindings[name] = provider;
    return name;
  }).join(", ");
  const orphaned = db
    .prepare(
      `UPDATE migrations
       SET state = CASE
             WHEN state = 'cancelling' OR github_migration_id IS NOT NULL
               OR (pipeline_step = 'ghec_starting' AND github_migration_id IS NULL)
                 OR (source_provider IN ('gitlab', 'bitbucket-server')
                   AND pipeline_step = 'source_export' AND source_export_id IS NULL)
               THEN 'reconciliation_required'
             ELSE 'failed'
           END,
           failure_reason = CASE
             WHEN state = 'cancelling' OR github_migration_id IS NOT NULL
               OR (pipeline_step = 'ghec_starting' AND github_migration_id IS NULL)
                 OR (source_provider IN ('gitlab', 'bitbucket-server')
                   AND pipeline_step = 'source_export' AND source_export_id IS NULL)
               THEN 'Server restarted with an unresolved remote migration outcome'
             ELSE 'Server restarted during migration'
           END,
           completed_at = $now
      WHERE state IN (${migrationStatesSql(ACTIVE_MIGRATION_STATES)})
         AND source_provider IN (${providerPlaceholders})
         AND id NOT LIKE 'seed-%'
         AND NOT (
           auth_mode IN ('env-app', 'env-pat')
           AND state IN (${migrationStatesSql(EXECUTING_MIGRATION_STATES)})
           AND (
             github_migration_id IS NOT NULL
             OR (source_provider IN ('gitlab', 'bitbucket-server')
               AND source_export_id IS NOT NULL)
             OR (target_platform = 'ghes' AND EXISTS (
               SELECT 1 FROM ghes_import_jobs job
               WHERE job.migration_id = migrations.id
                 AND job.phase NOT IN ('succeeded', 'failed', 'cancelled', 'reconciliation_required')
                 AND (job.exporter_job_id IS NOT NULL OR job.ghes_import_id IS NOT NULL)
             ))
           )
         )
         AND NOT (auth_mode IN ('env-app', 'env-pat') AND state = 'queued')`,
    )
    .run(providerBindings);
  if (orphaned.changes > 0) {
    console.log(
      `[migrate] Marked ${orphaned.changes} non-recoverable orphaned migration(s) as failed`,
    );
  }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Delete terminal migrations older than the age limit or outside the newest
 * row limit. Defaults come from `MIGRATION_RETENTION_DAYS` (90) and
 * `MIGRATION_RETENTION_ROWS` (100,000); zero disables that dimension. Events
 * and batch membership are removed in the same transaction. Active work is
 * never a retention candidate.
 */
export function pruneTerminalMigrationHistory(
  db: Database,
  options: { nowMs?: number; maxAgeDays?: number; maxRows?: number } = {},
): number {
  const nowMs = options.nowMs ?? Date.now();
  const maxAgeDays =
    options.maxAgeDays ?? positiveInteger(process.env.MIGRATION_RETENTION_DAYS, 90);
  const maxRows = options.maxRows ?? positiveInteger(process.env.MIGRATION_RETENTION_ROWS, 100_000);
  if (maxAgeDays === 0 && maxRows === 0) return 0;
  const cutoff = new Date(nowMs - maxAgeDays * 24 * 60 * 60_000).toISOString();
  const rows = db
    .prepare(
      `SELECT id FROM migrations
      WHERE state IN (${migrationStatesSql(FINISHED_MIGRATION_STATES)})
         AND (
           ($max_age_days > 0 AND COALESCE(completed_at, started_at) < $cutoff)
           OR ($max_rows > 0 AND id NOT IN (
             SELECT id FROM migrations
             WHERE state IN (${migrationStatesSql(FINISHED_MIGRATION_STATES)})
             ORDER BY COALESCE(completed_at, started_at) DESC, id DESC
             LIMIT $max_rows
           ))
         )`,
    )
    .all({ $max_age_days: maxAgeDays, $cutoff: cutoff, $max_rows: maxRows }) as Array<{
    id: string;
  }>;
  if (rows.length === 0) return 0;
  db.transaction(() => {
    const deleteBatchItems = db.prepare("DELETE FROM migration_batch_items WHERE migration_id = ?");
    const deleteEvents = db.prepare("DELETE FROM events WHERE migration_id = ?");
    const deleteMigration = db.prepare("DELETE FROM migrations WHERE id = ?");
    for (const { id } of rows) {
      deleteBatchItems.run(id);
      deleteEvents.run(id);
      deleteMigration.run(id);
    }
  })();
  return rows.length;
}

/** Migrate domain store descriptor — see `$lib/server/schemas`. */
export const migrateStore: DomainStore = {
  applySchema(db) {
    db.run(MIGRATE_DDL);
    // Columns added after the table's first release — upgrade older databases.
    addColumnIfMissing(db, "migrations", "source_size_kb", "INTEGER");
    addColumnIfMissing(db, "migrations", "source_export_id", "TEXT");
    addColumnIfMissing(db, "migrations", "source_provider", "TEXT NOT NULL DEFAULT 'github'");
    addColumnIfMissing(db, "migrations", "target_profile_id", "TEXT NOT NULL DEFAULT 'ghec'");
    addColumnIfMissing(db, "migrations", "target_platform", "TEXT NOT NULL DEFAULT 'ghec'");
    addColumnIfMissing(
      db,
      "migrations",
      "target_api_url",
      "TEXT NOT NULL DEFAULT 'https://api.github.com'",
    );
    migrateProviderSchema(db);
    db.run(MIGRATE_DDL);
    migrateBatchItemSchema(db);
    migrateBitbucketCheckpointSchema(db);
    migrateTargetProfileSchema(db);
    migrateGhesImportJobSchema(db);
    migrateGhesSourceLockSchema(db);
  },
  onInit(db) {
    recoverInterruptedMigrations(db);
    const pruned = pruneTerminalMigrationHistory(db);
    if (pruned > 0) console.log(`[migrate] Pruned ${pruned} retained migration(s)`);
  },
};
