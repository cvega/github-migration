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

  test("serializes competing legacy upgrades and retries an interrupted upgrade", async () => {
    const directory = mkdtempSync(join(tmpdir(), "profile-upgrade-"));
    const path = join(directory, "profile.db");
    const unavailable = { kind: "unavailable", reason: "not-reported" };
    const project = {
      provider: "gitlab",
      sourceId: "1",
      path: "acme/api",
      name: "api",
      visibility: "private",
      archived: false,
      defaultBranch: null,
      lastActivityAt: null,
      repositorySizeBytes: { kind: "exact", value: 0 },
      storageSizeBytes: unavailable,
      lfsObjectsSizeBytes: unavailable,
      packagesSizeBytes: unavailable,
      wikiSizeBytes: unavailable,
      uploadsSizeBytes: unavailable,
    };
    const projectCount = { kind: "at-least", value: 1 };
    const payload = JSON.stringify({
      version: 1,
      provider: "gitlab",
      sourceApiUrl: "https://gitlab.example/api/v4",
      namespace: "acme",
      projectCount,
      projects: [project],
    });

    try {
      {
        using db = new Database(path, { create: true });
        db.run("PRAGMA journal_mode = WAL");
        profileStore.applySchema(db);
        db.run(`ALTER TABLE profile_runs ADD COLUMN lease_managed INTEGER;
          CREATE VIEW legacy_leases AS SELECT lease_managed FROM profile_runs;
          INSERT INTO profile_runs (id, source_provider, source_api_url, org, started_at)
          VALUES ('legacy', 'gitlab', 'https://gitlab.example/api/v4', 'acme', '2026-08-01');
          INSERT INTO profile_repos (run_id, name_with_owner, created_at)
          VALUES ('legacy', 'acme/api', '2026-08-01')`);
        db.prepare(
          "INSERT INTO profile_source_inventories (run_id, payload, fetched_at) VALUES ('legacy', ?, '2026-08-01')",
        ).run(payload);

        // Failure at the last DDL statement must also roll back the earlier backfill.
        expect(() => profileStore.applySchema(db)).toThrow(/legacy_leases/);
        expect(db.query("SELECT payload FROM profile_source_inventories").get()).toEqual({
          payload,
        });
        expect(db.query("SELECT * FROM profile_source_inventory_projects").all()).toEqual([]);
        expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
        db.run("DROP VIEW legacy_leases");
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
      profileStore.applySchema(reopened);
      expect(
        reopened.query("SELECT payload, project_count FROM profile_source_inventories").get(),
      ).toEqual({
        payload: "{}",
        project_count: JSON.stringify(projectCount),
      });
      expect(
        reopened
          .query("SELECT run_id, position, payload FROM profile_source_inventory_projects")
          .all(),
      ).toEqual([{ run_id: "legacy", position: 0, payload: JSON.stringify(project) }]);
      expect(reopened.query("SELECT name_with_owner FROM profile_repos").all()).toEqual([
        { name_with_owner: "acme/api" },
      ]);
      expect(
        reopened
          .query("SELECT name FROM pragma_table_info('profile_runs') WHERE name = 'lease_managed'")
          .all(),
      ).toEqual([]);
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
