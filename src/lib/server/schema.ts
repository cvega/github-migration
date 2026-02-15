/**
 * Shared database schema — single source of truth for table DDL.
 * Used by both the app (store.ts) and the seed script (seed.ts).
 */
import type { Database } from "bun:sqlite";

/** Core DDL: tables + indexes. */
const SCHEMA_DDL = `
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
  CREATE INDEX IF NOT EXISTS idx_migrations_state ON migrations(state);
  CREATE INDEX IF NOT EXISTS idx_migrations_batch_id ON migrations(batch_id);
`;

/**
 * Apply pragmas, create tables/indexes, and run lightweight schema migrations.
 * Safe to call on an existing database — all statements use IF NOT EXISTS.
 */
export function applySchema(db: Database): void {
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run(SCHEMA_DDL);

  // Schema migration: add batch_id column if missing (for DBs created before batch support).
  const cols = db.prepare("PRAGMA table_info(migrations)").all() as Array<{
    name: string;
  }>;
  if (!cols.some((c) => c.name === "batch_id")) {
    db.run("ALTER TABLE migrations ADD COLUMN batch_id TEXT");
  }

  // Schema migration: add pipeline_step + auth_mode columns (crash recovery support).
  const colNames = new Set(cols.map((c) => c.name));
  if (!colNames.has("pipeline_step")) {
    db.run("ALTER TABLE migrations ADD COLUMN pipeline_step TEXT");
  }
  if (!colNames.has("auth_mode")) {
    db.run("ALTER TABLE migrations ADD COLUMN auth_mode TEXT");
  }
}
