import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  migrateStore,
  pruneTerminalMigrationHistory,
  recoverInterruptedMigrations,
} from "./schema";

function createCheckedMigrations(db: Database): void {
  db.run(`CREATE TABLE migrations (
    id TEXT PRIMARY KEY,
    batch_id TEXT,
    github_migration_id TEXT,
    source_provider TEXT NOT NULL DEFAULT 'github' CHECK ( source_provider IN ('github', 'gitlab') ),
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
  )`);
}

function insertMigration(db: Database, id: string): void {
  db.prepare(
    `INSERT INTO migrations
       (id, source_api_url, source_org, source_repo, target_org, target_repo, started_at)
     VALUES (?, 'https://api.github.com', 'acme', 'widget', 'acme-cloud', 'widget',
       '2026-08-08T12:00:00.000Z')`,
  ).run(id);
}

test("prunes only terminal migrations beyond the retention limit", () => {
  const db = new Database(":memory:");
  migrateStore.applySchema(db);
  for (const [id, state, completedAt] of [
    ["old-terminal", "failed", "2026-08-01T12:00:00.000Z"],
    ["new-terminal", "succeeded", "2026-08-02T12:00:00.000Z"],
    ["active", "running", null],
    ["review", "reconciliation_required", null],
  ] as const) {
    insertMigration(db, id);
    db.prepare("UPDATE migrations SET state = ?, completed_at = ? WHERE id = ?").run(
      state,
      completedAt,
      id,
    );
  }

  expect(
    pruneTerminalMigrationHistory(db, {
      nowMs: Date.parse("2026-08-02T12:00:00.000Z"),
      maxAgeDays: 0,
      maxRows: 1,
    }),
  ).toBe(1);
  expect(db.query("SELECT id FROM migrations ORDER BY id").all() as Array<{ id: string }>).toEqual([
    { id: "active" },
    { id: "new-terminal" },
    { id: "review" },
  ]);
  db.close();
});

describe("migration provider schema upgrade", () => {
  test("backfills legacy rows to GitHub across a file-backed reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "migration-provider-upgrade-"));
    const path = join(directory, "migrate.db");
    try {
      let db = new Database(path, { create: true });
      db.run(`CREATE TABLE migrations (
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
      )`);
      db.prepare(
        `INSERT INTO migrations
           (id, source_api_url, source_org, source_repo, target_org, target_repo, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "legacy",
        "https://api.github.com",
        "acme",
        "widget",
        "acme-cloud",
        "widget",
        "2026-08-08T12:00:00.000Z",
      );

      migrateStore.applySchema(db);
      migrateStore.applySchema(db);
      db.close();

      db = new Database(path);
      expect(db.query("SELECT source_provider FROM migrations WHERE id = 'legacy'").get()).toEqual({
        source_provider: "github",
      });
      expect(db.run("UPDATE migrations SET source_provider = 'gitlab'").changes).toBe(1);
      db.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("widens a checked schema while preserving children and indexes across reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "migration-provider-widen-"));
    const path = join(directory, "migrate.db");
    try {
      let db = new Database(path, { create: true });
      db.run("PRAGMA foreign_keys = ON");
      createCheckedMigrations(db);
      db.run(`CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        migration_id TEXT NOT NULL REFERENCES migrations(id),
        event_type TEXT NOT NULL,
        phase TEXT,
        payload TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      )`);
      insertMigration(db, "checked");
      db.run(
        "INSERT INTO events (migration_id, event_type, created_at) VALUES ('checked', 'step', '2026-08-08T12:01:00Z')",
      );
      migrateStore.applySchema(db);
      expect(
        db.run("UPDATE migrations SET source_provider = 'bitbucket-server' WHERE id = 'checked'")
          .changes,
      ).toBe(1);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(
        db.query("SELECT COUNT(*) AS count FROM events WHERE migration_id = 'checked'").get(),
      ).toEqual({ count: 1 });
      expect(
        (db.query("PRAGMA index_list(migrations)").all() as Array<{ name: string }>).map(
          (row) => row.name,
        ),
      ).toContain("idx_migrations_state");
      db.close();

      db = new Database(path);
      expect(db.query("SELECT source_provider FROM migrations WHERE id = 'checked'").get()).toEqual(
        { source_provider: "bitbucket-server" },
      );
      expect(
        db.query("SELECT version FROM app_schema_versions WHERE domain = 'migrate'").get(),
      ).toEqual({ version: 7 });
      expect(
        (db.query("PRAGMA table_info(migrations)").all() as Array<{ name: string }>).map(
          (column) => column.name,
        ),
      ).toContain("source_export_id");
      expect(
        db
          .query(
            "SELECT target_profile_id, target_platform, target_api_url FROM migrations WHERE id = 'checked'",
          )
          .get(),
      ).toEqual({
        target_profile_id: "ghec",
        target_platform: "ghec",
        target_api_url: "https://api.github.com",
      });
      db.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rolls back the widening transaction when the replacement table cannot be created", () => {
    const db = new Database(":memory:");
    createCheckedMigrations(db);
    insertMigration(db, "rollback");
    db.run("CREATE TABLE migrations_next (id TEXT PRIMARY KEY)");

    expect(() => migrateStore.applySchema(db)).toThrow();
    expect(db.query("SELECT source_provider FROM migrations WHERE id = 'rollback'").get()).toEqual({
      source_provider: "github",
    });
    expect(() =>
      db.run("UPDATE migrations SET source_provider = 'bitbucket-server' WHERE id = 'rollback'"),
    ).toThrow();
    expect(
      db.query("SELECT version FROM app_schema_versions WHERE domain = 'migrate'").get(),
    ).toBeNull();
    db.close();
  });
});

describe("migration startup recovery", () => {
  test("classifies durable work correctly after a file-backed reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "migration-recovery-matrix-"));
    const path = join(directory, "migrate.db");
    const nowMs = Date.parse("2026-08-10T12:00:00.000Z");
    const insert = (
      db: Database,
      id: string,
      input: {
        state: string;
        authMode?: string;
        githubMigrationId?: string;
        sourceExportId?: string;
        pipelineStep?: string;
        sourceProvider?: string;
      },
    ) => {
      db.prepare(
        `INSERT INTO migrations
           (id, github_migration_id, source_export_id, source_provider, source_api_url, source_org, source_repo,
            target_org, target_repo, state, started_at, pipeline_step, auth_mode, request_options)
          VALUES (?, ?, ?, ?, 'https://api.github.com', 'acme', ?, 'acme-cloud', ?, ?, ?, ?, ?, '{}')`,
      ).run(
        id,
        input.githubMigrationId ?? null,
        input.sourceExportId ?? null,
        input.sourceProvider ?? "github",
        id,
        id,
        input.state,
        new Date(nowMs - 60_000).toISOString(),
        input.pipelineStep ?? null,
        input.authMode ?? null,
      );
    };

    try {
      let db = new Database(path, { create: true });
      migrateStore.applySchema(db);
      insert(db, "interrupted", { state: "running", authMode: "request-pat" });
      insert(db, "cancelling", { state: "cancelling", authMode: "env-pat" });
      insert(db, "ambiguous-start", {
        state: "running",
        authMode: "env-pat",
        pipelineStep: "ghec_starting",
      });
      insert(db, "request-auth", { state: "pending", authMode: "request-pat" });
      insert(db, "request-remote", {
        state: "running",
        authMode: "request-pat",
        githubMigrationId: "RM_ambiguous",
      });
      insert(db, "env-remote", {
        state: "running",
        authMode: "env-app",
        githubMigrationId: "RM_recoverable",
      });
      insert(db, "bitbucket-export", {
        state: "running",
        authMode: "env-pat",
        sourceProvider: "bitbucket-server",
        sourceExportId: "42",
        pipelineStep: "source_export",
      });
      insert(db, "gitlab-export", {
        state: "running",
        authMode: "env-pat",
        sourceProvider: "gitlab",
        sourceExportId: "gitlab",
        pipelineStep: "source_export",
      });
      insert(db, "bitbucket-export-ambiguous", {
        state: "running",
        authMode: "env-pat",
        sourceProvider: "bitbucket-server",
        pipelineStep: "source_export",
      });
      insert(db, "gitlab-export-ambiguous", {
        state: "running",
        authMode: "env-pat",
        sourceProvider: "gitlab",
        pipelineStep: "source_export",
      });
      insert(db, "env-queued", { state: "queued", authMode: "env-pat" });
      insert(db, "request-queued", { state: "queued", authMode: "request-pat" });
      insert(db, "unknown-provider", {
        state: "running",
        authMode: "env-pat",
        githubMigrationId: "RM_unknown",
        sourceProvider: "future-provider",
      });
      db.close();

      db = new Database(path);
      migrateStore.applySchema(db);
      recoverInterruptedMigrations(db, nowMs);
      const rows = Object.fromEntries(
        (
          db.query("SELECT id, state, failure_reason FROM migrations ORDER BY id").all() as Array<{
            id: string;
            state: string;
            failure_reason: string | null;
          }>
        ).map((row) => [row.id, row]),
      );

      expect(rows.interrupted?.state).toBe("failed");
      expect(rows.cancelling?.state).toBe("reconciliation_required");
      expect(rows["ambiguous-start"]?.state).toBe("reconciliation_required");
      expect(rows["request-auth"]?.state).toBe("failed");
      expect(rows["request-remote"]?.state).toBe("reconciliation_required");
      expect(rows["env-remote"]?.state).toBe("running");
      expect(rows["bitbucket-export"]?.state).toBe("running");
      expect(rows["gitlab-export"]?.state).toBe("running");
      expect(rows["bitbucket-export-ambiguous"]?.state).toBe("reconciliation_required");
      expect(rows["gitlab-export-ambiguous"]?.state).toBe("reconciliation_required");
      expect(rows["env-queued"]?.state).toBe("queued");
      expect(rows["request-queued"]?.state).toBe("failed");
      expect(rows["unknown-provider"]).toMatchObject({ state: "running", failure_reason: null });
      db.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
