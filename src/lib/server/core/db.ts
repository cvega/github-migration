import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

let db: Database | undefined;

export const BUSY_TIMEOUT_MS = 5000;
const WAL_RETRY_DELAY_MS = 10;

export interface DomainStore {
  domain: string;
  version: number;
  tables: readonly DurableTableContract[];
  applySchema(db: Database): void;
  onInit?(db: Database): void;
}

export interface DurableTableContract {
  name: string;
  purpose: string;
  notes: string;
}

export const VERSION_TABLE = {
  name: "app_schema_versions",
  purpose: "Per-domain schema versions",
  notes: "Startup requires exactly the current auth, migrate, and profile baselines",
} as const;

export function validateSchema(database: Database, domains: readonly DomainStore[]): void {
  const tables = new Set(
    database
      .query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE type = 'table'")
      .all()
      .map((row) => row.name),
  );
  const incompatible = "Unsupported database schema. Start with a fresh data directory.";
  if (!tables.has(VERSION_TABLE.name)) throw new Error(incompatible);
  let rows: { domain: string; version: number }[];
  try {
    rows = database
      .query<{ domain: string; version: number }, []>(
        "SELECT domain, version FROM app_schema_versions",
      )
      .all();
  } catch (cause) {
    throw new Error(incompatible, { cause });
  }
  if (
    rows.length !== domains.length ||
    !domains.every(
      (store) =>
        rows.some((row) => row.domain === store.domain && row.version === store.version) &&
        store.tables.every((table) => tables.has(table.name)),
    )
  )
    throw new Error(incompatible);
}

export function initializeSchema(database: Database, domains: readonly DomainStore[]): void {
  database
    .transaction(() => {
      if (
        !database.query("SELECT 1 FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' LIMIT 1").get()
      ) {
        database.run(
          "CREATE TABLE IF NOT EXISTS app_schema_versions (domain TEXT PRIMARY KEY NOT NULL, version INTEGER NOT NULL)",
        );
        const record = database.prepare(
          "INSERT INTO app_schema_versions (domain, version) VALUES (?, ?)",
        );
        for (const store of domains) {
          store.applySchema(database);
          record.run(store.domain, store.version);
        }
        return;
      }

      validateSchema(database, domains);
    })
    .immediate();
}

export interface WalRetryOptions {
  timeoutMs?: number;
  sleep?: (ms: number) => void;
  now?: () => number;
}

function isBusy(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.startsWith("SQLITE_BUSY");
}

/**
 * Switch to WAL, retrying while another connection holds a lock. SQLite returns
 * SQLITE_BUSY for this switch without consulting busy_timeout when a peer holds
 * a write lock, so concurrent first starts must retry within the same bound.
 */
export function enableWal(
  database: Database,
  {
    timeoutMs = BUSY_TIMEOUT_MS,
    sleep = (ms) => Bun.sleepSync(ms),
    now = () => performance.now(),
  }: WalRetryOptions = {},
): void {
  const deadline = now() + timeoutMs;
  for (;;) {
    try {
      database.run("PRAGMA journal_mode = WAL");
      return;
    } catch (error) {
      if (!isBusy(error) || now() >= deadline) throw error;
      sleep(WAL_RETRY_DELAY_MS);
    }
  }
}

export function initStore(
  dbPath: string,
  domains: readonly DomainStore[],
  { runStartupHooks = true }: { runStartupHooks?: boolean } = {},
): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  const database = new Database(dbPath, { create: true });
  try {
    database.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    database.run("PRAGMA foreign_keys = ON");
    initializeSchema(database, domains);
    enableWal(database);
    if (runStartupHooks) {
      for (const domain of domains) domain.onInit?.(database);
    }
    db = database;
  } catch (error) {
    try {
      if (database.inTransaction) database.run("ROLLBACK");
    } finally {
      database.close();
    }
    throw error;
  }
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
