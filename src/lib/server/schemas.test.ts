import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authStore } from "./core/auth/schema";
import { getDb, initializeSchema, initStore } from "./core/db";
import { migrateStore } from "./migrate/database/schema";
import { profileStore } from "./profile/database/schema";
import { DOMAIN_STORES } from "./schemas";

beforeEach(() => initStore(":memory:", DOMAIN_STORES));

describe("domain schema registry", () => {
  test("registers durable domains in dependency-safe startup order", () => {
    expect(DOMAIN_STORES).toEqual([authStore, migrateStore, profileStore]);
  });

  test("applies auth, migrate, and profile schemas to the same database", () => {
    const tables = getDb()
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map(({ name }) => name);

    expect(tables).toContain("app_users");
    expect(tables).toContain("app_sessions");
    expect(tables).toContain("migrations");
    expect(tables).toContain("migration_batch_items");
    expect(tables).toContain("profile_runs");
    expect(tables).toContain("profile_repos");
  });
});

interface ChildResult {
  code: number;
  stderr: string;
}

function startStoreChild(path: string, runStartupHooks: boolean) {
  const proc = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
      import { initStore, closeStore } from "$lib/server/core/db";
      import { DOMAIN_STORES } from "$lib/server/schemas";
      initStore(process.argv[1], DOMAIN_STORES, { runStartupHooks: ${runStartupHooks} });
      closeStore();`,
      path,
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  return Promise.all([proc.exited, new Response(proc.stderr).text()]).then(
    ([code, stderr]): ChildResult => ({ code, stderr }),
  );
}

function expectChildrenSucceeded(results: ChildResult[]) {
  const failures = results
    .map((result, index) => ({ ...result, index }))
    .filter((result) => result.code !== 0)
    .map((result) => `child ${result.index} exited ${result.code}:\n${result.stderr.trim()}`);
  expect(failures.join("\n---\n")).toBe("");
}

function expectInitializedStore(path: string) {
  using database = new Database(path);
  initializeSchema(database, DOMAIN_STORES);
  expect(
    database.query("SELECT domain, version FROM app_schema_versions ORDER BY domain").values(),
  ).toEqual([
    ["auth", 5],
    ["migrate", 11],
    ["profile", 1],
  ]);
  expect(database.query("PRAGMA journal_mode").values()).toEqual([["wal"]]);
}

test("dashboard and analysis worker can initialize the same fresh store concurrently", async () => {
  const directory = mkdtempSync(join(tmpdir(), "baseline-race-"));
  const path = join(directory, "gh-migrate.db");
  try {
    expectChildrenSucceeded(
      await Promise.all([startStoreChild(path, true), startStoreChild(path, false)]),
    );
    expectInitializedStore(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("repeated concurrent starts on fresh stores all succeed", async () => {
  const roots = Array.from({ length: 25 }, () => mkdtempSync(join(tmpdir(), "baseline-stress-")));
  try {
    for (let round = 0; round < 4; round++) {
      const paths = roots.map((root, index) =>
        join(root, `round-${round}-${index}`, "gh-migrate.db"),
      );
      const results = await Promise.all(
        paths.flatMap((path) =>
          [true, false, false, true, false, true].map((hooks) => startStoreChild(path, hooks)),
        ),
      );
      expectChildrenSucceeded(results);
      for (const path of paths) expectInitializedStore(path);
    }
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test.each([
  "CREATE TABLE profile_source_inventories (payload TEXT)",
  "CREATE TABLE app_schema_versions (domain TEXT PRIMARY KEY, version INTEGER); INSERT INTO app_schema_versions VALUES ('auth', 4), ('migrate', 10)",
  "CREATE TABLE app_schema_versions (wrong TEXT)",
])("rejects a pre-cutover database before creating tables: %s", (ddl) => {
  using database = new Database(":memory:");
  database.run(ddl);
  const schema = database.query("SELECT * FROM sqlite_schema").all();
  expect(() => initializeSchema(database, DOMAIN_STORES)).toThrow(
    "Start with a fresh data directory",
  );
  expect(database.query("SELECT * FROM sqlite_schema").all()).toEqual(schema);
});

test.each([
  "UPDATE app_schema_versions SET version = 2 WHERE domain = 'profile'",
  "DELETE FROM app_schema_versions WHERE domain = 'migrate'",
  "INSERT INTO app_schema_versions VALUES ('unexpected', 1)",
  "DROP TABLE profile_repos",
])("rejects a mismatched or partial store without repairing it: %s", (sql) => {
  const database = getDb();
  database.run(sql);
  const rows = database.query("SELECT * FROM app_schema_versions").all();
  const schema = database.query("SELECT * FROM sqlite_schema").all();
  expect(() => initializeSchema(database, DOMAIN_STORES)).toThrow(
    "Start with a fresh data directory",
  );
  expect(database.query("SELECT * FROM app_schema_versions").all()).toEqual(rows);
  expect(database.query("SELECT * FROM sqlite_schema").all()).toEqual(schema);
});
