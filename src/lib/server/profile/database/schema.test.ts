import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
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
