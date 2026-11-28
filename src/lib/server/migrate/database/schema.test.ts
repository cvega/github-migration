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

describe("migration schema", () => {
  test("preserves admitted identity, checkpoints and observations across reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "migration-schema-"));
    const path = join(directory, "migrate.db");
    try {
      {
        using db = new Database(path, { create: true });
        migrateStore.applySchema(db);
        insertMigration(db, "job");
        db.run(`UPDATE migrations SET owner_user_id='operator', source_provider='bitbucket-server',
          batch_id='batch', source_export_id='42', github_migration_id='RM_fixture',
          target_counts='{"issues":5}', migration_log_url='https://github.com/migrations/log'`);
        db.run(`INSERT INTO migration_batch_items
          (batch_id,source_org,source_repo,target_repo,migration_id)
          VALUES ('batch','acme','widget','widget','job')`);
        db.run(`INSERT INTO events (migration_id,event_type,payload,created_at)
          VALUES ('job','complete','{"sourceCounts":null}','2026-08-08T12:01:00Z')`);
      }
      using db = new Database(path);
      migrateStore.applySchema(db);
      expect(
        db
          .query(`SELECT owner_user_id, source_provider, source_export_id, github_migration_id,
        target_profile_id, target_platform, target_api_url, source_counts, target_counts,
        migration_log_url FROM migrations WHERE id='job'`)
          .get(),
      ).toEqual({
        owner_user_id: "operator",
        source_provider: "bitbucket-server",
        source_export_id: "42",
        github_migration_id: "RM_fixture",
        target_profile_id: "ghec",
        target_platform: "ghec",
        target_api_url: "https://api.github.com",
        source_counts: null,
        target_counts: '{"issues":5}',
        migration_log_url: "https://github.com/migrations/log",
      });
      expect(db.query("SELECT payload FROM events WHERE migration_id='job'").get()).toEqual({
        payload: '{"sourceCounts":null}',
      });
      expect(
        db.query("SELECT migration_id FROM migration_batch_items WHERE batch_id='batch'").all(),
      ).toEqual([{ migration_id: "job" }]);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(
        db
          .query(
            "SELECT partial FROM pragma_index_list('migrations') WHERE name='idx_migrations_owner'",
          )
          .get(),
      ).toEqual({ partial: 1 });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("retries a failed schema initialization atomically", () => {
    using db = new Database(":memory:");
    db.run("CREATE TABLE idx_migrations_owner (id TEXT)");
    expect(() => migrateStore.applySchema(db)).toThrow();
    expect(db.query("SELECT name FROM sqlite_schema WHERE name='migrations'").get()).toBeNull();
    db.run("DROP TABLE idx_migrations_owner");
    migrateStore.applySchema(db);
    insertMigration(db, "job");
    expect(db.query("SELECT source_provider FROM migrations WHERE id='job'").get()).toEqual({
      source_provider: "github",
    });
    expect(
      db.query("SELECT name FROM sqlite_schema WHERE name='app_schema_versions'").get(),
    ).toBeNull();
  });

  test("enforces batch membership constraints on a fresh store", () => {
    using db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    migrateStore.applySchema(db);
    insertMigration(db, "first");
    insertMigration(db, "second");
    const add = db.prepare(`INSERT INTO migration_batch_items
      (batch_id,source_org,source_repo,target_repo,migration_id) VALUES ('batch','acme',?,'widget',?)`);
    add.run("widget", "first");
    expect(() => add.run("WIDGET", "second")).toThrow();
    expect(() => add.run("other", "first")).toThrow();
    expect(() => add.run("other", "missing")).toThrow();
    db.run("DELETE FROM migrations WHERE id='first'");
    expect(db.query("SELECT migration_id FROM migration_batch_items").all()).toEqual([]);
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
        sourceApiUrl?: string;
      },
    ) => {
      db.prepare(
        `INSERT INTO migrations
           (id, github_migration_id, source_export_id, source_provider, source_api_url, source_org, source_repo,
            target_org, target_repo, state, started_at, pipeline_step, auth_mode, request_options)
          VALUES (?, ?, ?, ?, ?, 'acme', ?, 'acme-cloud', ?, ?, ?, ?, ?, '{}')`,
      ).run(
        id,
        input.githubMigrationId ?? null,
        input.sourceExportId ?? null,
        input.sourceProvider ?? "github",
        input.sourceApiUrl ?? "https://api.github.com",
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
      insert(db, "github-source-write", {
        state: "running",
        authMode: "env-pat",
        pipelineStep: "source_export",
      });
      insert(db, "legacy-ghes-export", {
        state: "running",
        authMode: "env-pat",
        pipelineStep: "archiving",
        sourceApiUrl: "https://ghes.example/api/v3/",
      });
      insert(db, "cloud-no-export", {
        state: "running",
        authMode: "env-pat",
        pipelineStep: "archiving",
        sourceApiUrl: "https://api.tenant.ghe.com/api/v3",
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
      expect(rows["github-source-write"]?.state).toBe("reconciliation_required");
      expect(rows["legacy-ghes-export"]?.state).toBe("reconciliation_required");
      expect(rows["cloud-no-export"]?.state).toBe("failed");
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
