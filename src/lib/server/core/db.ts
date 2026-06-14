/**
 * Database connection primitive — owns the SQLite handle lifecycle and the
 * schema-application mechanism, but knows nothing about any domain's tables.
 *
 * Each domain contributes a {@link DomainStore} (its DDL + optional startup
 * hook); the composition root (`$lib/server/registry`) assembles them and the
 * app/tests pass the list to {@link initStore}. This keeps `core` free of any
 * domain dependency: a new `server/<domain>` plugs in by exporting a
 * `DomainStore` and registering it — core never changes.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

let db: Database | undefined;

/**
 * A domain's persistence contribution: how to create its tables and any
 * one-time work to run at startup (e.g. recovering jobs interrupted by a
 * restart). `applySchema` must be idempotent (every statement IF NOT EXISTS).
 */
export interface DomainStore {
  applySchema(db: Database): void;
  onInit?(db: Database): void;
}

/**
 * Open the database, apply pragmas, then apply every domain's schema followed
 * by every domain's startup hook. Safe to call repeatedly (tests reopen with
 * `:memory:`); all DDL is IF NOT EXISTS.
 */
export function initStore(dbPath: string, domains: DomainStore[]): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  db = new Database(dbPath, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  for (const domain of domains) domain.applySchema(db);
  for (const domain of domains) domain.onInit?.(db);
}

/** The live connection. Throws if {@link initStore} hasn't run yet. */
export function getDb(): Database {
  if (!db) throw new Error("Store not initialized — call initStore() first");
  return db;
}

/** Close the connection (graceful shutdown). */
export function closeStore(): void {
  if (db) {
    db.close();
    db = undefined;
    console.log("[db] Database closed");
  }
}

/**
 * Add a column to an existing table only if it isn't already present — the
 * lightweight, framework-free way domains upgrade older databases. Exposed for
 * domain `applySchema` implementations.
 */
export function addColumnIfMissing(
  db: Database,
  table: string,
  column: string,
  type: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
