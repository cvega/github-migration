import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

let db: Database | undefined;

export interface DomainStore {
  applySchema(db: Database): void;
  onInit?(db: Database): void;
}

export interface DurableTableContract {
  name: string;
  purpose: string;
  notes: string;
}

export function initStore(dbPath: string, domains: readonly DomainStore[]): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  db = new Database(dbPath, { create: true });
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  for (const domain of domains) domain.applySchema(db);
  for (const domain of domains) domain.onInit?.(db);
}

export function getDb(): Database {
  if (!db) throw new Error("Store not initialized — call initStore() first");
  return db;
}

export function checkStoreReady(): void {
  const database = getDb();
  database.run("SELECT 1");
  database.run("BEGIN IMMEDIATE");
  try {
    database.run("CREATE TABLE __gh_migrate_readiness_probe (id INTEGER)");
  } finally {
    database.run("ROLLBACK");
  }
}

export function closeStore(): void {
  if (db) {
    db.close();
    db = undefined;
    console.log("[db] Database closed");
  }
}

export function addColumnIfMissing(
  database: Database,
  table: string,
  column: string,
  type: string,
): void {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  if (!columns.some((candidate) => candidate.name === column)) {
    try {
      database.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("duplicate column name")) {
        throw error;
      }
    }
  }
}
