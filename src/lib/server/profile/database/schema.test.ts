import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROFILE_DURABLE_TABLES,
  profileStore,
  pruneProfileHistory,
  recoverInterruptedProfiles,
} from "./schema";

function insertRun(
  database: Database,
  id: string,
  state: "running" | "completed" | "failed",
  startedAt: string,
): void {
  database
    .prepare(
      `INSERT INTO profile_runs
				(id, source_provider, source_api_url, org, state, started_at, completed_at)
			 VALUES (?, 'github', 'https://api.github.com', 'acme', ?, ?, ?)`,
    )
    .run(id, state, startedAt, state === "running" ? null : startedAt);
}

describe("profile database schema", () => {
  test("creates every durable profile table", () => {
    const database = new Database(":memory:");
    profileStore.applySchema(database);
    const tables = database
      .query("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const names = new Set(tables.map(({ name }) => name));
    for (const contract of PROFILE_DURABLE_TABLES) expect(names.has(contract.name)).toBe(true);
    database.close();
  });

  test("creates normalized inventory for current providers with enforced foreign keys", () => {
    using db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    profileStore.applySchema(db);
    expect(
      db.query("SELECT name FROM pragma_table_info('profile_source_inventories')").all(),
    ).toEqual([
      { name: "run_id" },
      { name: "project_count" },
      { name: "summary" },
      { name: "fetched_at" },
    ]);
    const inventory = db.prepare(
      `INSERT INTO profile_source_inventories (run_id, project_count, summary, fetched_at)
      VALUES (?, '{"kind":"unavailable","reason":"not-reported"}', '{}', '2026-08-02')`,
    );
    expect(() => inventory.run("missing")).toThrow(/FOREIGN KEY/);
    for (const provider of ["github", "gitlab", "bitbucket-server"]) {
      db.prepare(
        "INSERT INTO profile_runs (id, source_provider, source_api_url, org, started_at) VALUES (?, ?, 'https://example.com', 'acme', '2026-08-01')",
      ).run(provider, provider);
      expect(() =>
        db.run("INSERT INTO profile_source_inventories (run_id, fetched_at) VALUES (?, 'now')", [
          provider,
        ]),
      ).toThrow(/NOT NULL/);
      inventory.run(provider);
    }
    profileStore.applySchema(db);
    expect(db.query("SELECT COUNT(*) AS n FROM profile_source_inventories").get()).toEqual({
      n: 3,
    });
    expect(
      db
        .query("SELECT project_count FROM profile_source_inventories WHERE run_id = 'github'")
        .get(),
    ).toEqual({
      project_count: JSON.stringify({ kind: "unavailable", reason: "not-reported" }),
    });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  test("rolls back incomplete DDL and serializes fresh initialization across connections", async () => {
    const directory = mkdtempSync(join(tmpdir(), "profile-startup-"));
    const path = join(directory, "profile.db");
    try {
      {
        using db = new Database(path, { create: true });
        db.run("PRAGMA journal_mode = WAL");
        db.run("CREATE TABLE idx_profile_runs_state (id INTEGER)");
        expect(() => profileStore.applySchema(db)).toThrow(/idx_profile_runs_state/);
        expect(
          db.query("SELECT name FROM sqlite_master WHERE name = 'profile_runs'").get(),
        ).toBeNull();
        db.run("DROP TABLE idx_profile_runs_state");
        db.run("BEGIN IMMEDIATE");

        // Hold both startup connections at the writer lock before releasing them.
        const startup = () =>
          Bun.spawn(
            [
              process.execPath,
              "-e",
              `
          import { Database } from "bun:sqlite";
          import { profileStore } from "./src/lib/server/profile/database/schema";
          using db = new Database(process.argv[1]);
          db.run("PRAGMA busy_timeout = 5000");
          console.log("ready");
          profileStore.applySchema(db);
        `,
              path,
            ],
            { stdout: "pipe", stderr: "pipe" },
          );
        const processes = [startup(), startup()];
        try {
          await Promise.all(
            processes.map(async (child) => {
              const reader = child.stdout.getReader();
              expect(new TextDecoder().decode((await reader.read()).value).trim()).toBe("ready");
              reader.releaseLock();
            }),
          );
          db.run("COMMIT");
          await Promise.all(
            processes.map(async (child) => {
              expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
            }),
          );
        } finally {
          for (const child of processes) child.kill();
        }
      }
      using reopened = new Database(path);
      const tables = reopened.query("SELECT name FROM sqlite_master WHERE type = 'table'").all();
      for (const { name } of PROFILE_DURABLE_TABLES) expect(tables).toContainEqual({ name });
      expect(reopened.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("fails interrupted runs at startup", () => {
    const database = new Database(":memory:");
    profileStore.applySchema(database);
    insertRun(database, "interrupted", "running", "2026-08-01T00:00:00.000Z");
    recoverInterruptedProfiles(database, Date.parse("2026-08-17T12:00:00.000Z"));
    expect(database.query("SELECT state, failure_reason FROM profile_runs").get()).toEqual({
      state: "failed",
      failure_reason: "Server restarted during profiling",
    });
    database.close();
  });

  test.each([
    { maxAgeDays: 1, maxRuns: 0 },
    { maxAgeDays: 0, maxRuns: 1 },
  ])("protects analysis and its evidence with retention %o", (limits) => {
    using db = new Database(":memory:");
    profileStore.applySchema(db);
    db.run("PRAGMA foreign_keys = ON");
    const options = { ...limits, nowMs: Date.parse("2026-08-10T12:00:00Z") };
    insertRun(db, "protected", "completed", "2026-08-02");
    db.run(`INSERT INTO profile_repos (id, run_id, name_with_owner, created_at)
        VALUES (1, 'protected', 'acme/api', '2026-08-02');
      INSERT INTO profile_repository_analysis_runs
        (id, profile_run_id, state, selected_repo_count, started_at)
        VALUES ('prior', 'protected', 'completed', 1, '2026-08-03'),
               ('active', 'protected', 'queued', 1, '2026-08-04');
      INSERT INTO profile_repository_analysis_jobs
        (id, analysis_run_id, profile_repo_id, name_with_owner, state)
        VALUES ('done', 'prior', 1, 'acme/api', 'succeeded'),
               ('work', 'active', 1, 'acme/api', 'queued');
      INSERT INTO profile_repository_analysis_results
        (id, analysis_job_id, attempt, captured_at, git_version, git_lfs_version, git_sizer_version)
        VALUES ('result', 'done', 1, '2026-08-03', 'git', 'lfs', 'sizer');
      INSERT INTO profile_repository_analysis_lfs_pointers
        VALUES ('result', 'oid', 123, 'file.bin')`);

    if (limits.maxRuns) {
      insertRun(db, "older", "failed", "2026-08-01");
      // A protected profile does not consume the one eligible history slot.
      expect(pruneProfileHistory(db, options)).toBe(0);
    }
    insertRun(db, "newest", "completed", "2026-08-10");
    expect(pruneProfileHistory(db, options)).toBe(limits.maxRuns);
    db.run(`UPDATE profile_repository_analysis_runs SET state = 'running' WHERE id = 'active';
      UPDATE profile_repository_analysis_jobs SET state = 'running', lease_owner = 'worker',
        lease_expires_at = '2026-08-11' WHERE id = 'work'`);
    expect(pruneProfileHistory(db, options)).toBe(0);
    expect(
      db.query("SELECT lease_owner FROM profile_repository_analysis_jobs WHERE id = 'work'").get(),
    ).toEqual({ lease_owner: "worker" });
    db.run(`UPDATE profile_repository_analysis_jobs SET state = 'succeeded' WHERE id = 'work';
      UPDATE profile_repository_analysis_runs SET state = 'finalizing' WHERE id = 'active'`);
    expect(pruneProfileHistory(db, options)).toBe(0);
    const pointers = db.query("SELECT oid FROM profile_repository_analysis_lfs_pointers");
    expect(pointers.all()).toEqual([{ oid: "oid" }]);

    db.run("UPDATE profile_repository_analysis_runs SET state = 'completed' WHERE id = 'active'");
    expect(pruneProfileHistory(db, options)).toBe(1);
    expect(db.query("SELECT id FROM profile_runs").all()).toEqual([{ id: "newest" }]);
    expect(pointers.all()).toEqual([]);
  });

  test("prunes only terminal history outside retention", () => {
    const database = new Database(":memory:");
    profileStore.applySchema(database);
    insertRun(database, "old", "completed", "2026-08-01T00:00:00.000Z");
    insertRun(database, "new", "completed", "2026-08-02T00:00:00.000Z");
    insertRun(database, "active", "running", "2026-08-03T00:00:00.000Z");

    expect(pruneProfileHistory(database, { maxAgeDays: 0, maxRuns: 1 })).toBe(1);
    expect(database.query("SELECT id FROM profile_runs ORDER BY id").all()).toEqual([
      { id: "active" },
      { id: "new" },
    ]);
    database.close();
  });
});
