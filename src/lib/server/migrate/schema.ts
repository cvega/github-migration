/**
 * The Migrate domain's persistence contribution: its table DDL and the startup
 * recovery that marks migrations interrupted by a restart as failed.
 *
 * Registered via `$lib/server/registry` so {@link initStore} applies it at
 * startup. The query functions themselves live in `./store`.
 */
import type { Database } from "bun:sqlite";
import { addColumnIfMissing, type DomainStore } from "$lib/server/core/db";

const MIGRATE_DDL = `
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
    elapsed_seconds REAL,
    pipeline_step TEXT,
    auth_mode TEXT,
    request_options TEXT,
    source_size_kb INTEGER,
    target_preexisted INTEGER,
    target_repo_node_id TEXT
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
  CREATE INDEX IF NOT EXISTS idx_migrations_state ON migrations(state);
  CREATE INDEX IF NOT EXISTS idx_migrations_batch_id ON migrations(batch_id);
`;

/**
 * On startup, fail the migrations that can't be recovered after a restart.
 * Recoverable env-auth runs (a running/pending one with a github_migration_id,
 * or a queued one) are left for the manager's recoverOrphans() to reconnect.
 */
function recoverInterruptedMigrations(db: Database): void {
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
      `[migrate] Marked ${orphaned.changes} non-recoverable orphaned migration(s) as failed`,
    );
  }
}

/** Migrate domain store descriptor — see `$lib/server/registry`. */
export const migrateStore: DomainStore = {
  applySchema(db) {
    db.run(MIGRATE_DDL);
    // Columns added after the table's first release — upgrade older databases.
    addColumnIfMissing(db, "migrations", "source_size_kb", "INTEGER");
    addColumnIfMissing(db, "migrations", "target_preexisted", "INTEGER");
    addColumnIfMissing(db, "migrations", "target_repo_node_id", "TEXT");
  },
  onInit: recoverInterruptedMigrations,
};
