import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addColumnIfMissing, checkStoreReady, closeStore, getDb, initStore } from "./db";

let directory: string | undefined;

afterEach(() => {
  closeStore();
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("database lifecycle", () => {
  test("applies every schema before running startup hooks", () => {
    directory = mkdtempSync(join(tmpdir(), "gh-migrate-db-"));
    const calls: string[] = [];
    initStore(join(directory, "store.sqlite"), [
      {
        applySchema(database) {
          calls.push("schema-a");
          database.run("CREATE TABLE a (id INTEGER PRIMARY KEY)");
        },
        onInit(database) {
          calls.push("init-a");
          expect(
            database.query("SELECT name FROM sqlite_master WHERE name = 'b'").get(),
          ).not.toBeNull();
        },
      },
      {
        applySchema(database) {
          calls.push("schema-b");
          database.run("CREATE TABLE b (id INTEGER PRIMARY KEY)");
        },
        onInit() {
          calls.push("init-b");
        },
      },
    ]);

    expect(calls).toEqual(["schema-a", "schema-b", "init-a", "init-b"]);
    expect(getDb().query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  });

  test("checks write readiness without persisting the probe table", () => {
    directory = mkdtempSync(join(tmpdir(), "gh-migrate-db-"));
    initStore(join(directory, "store.sqlite"), []);

    checkStoreReady();

    expect(
      getDb()
        .query("SELECT name FROM sqlite_master WHERE name = '__gh_migrate_readiness_probe'")
        .get(),
    ).toBeNull();
  });

  test("adds missing columns idempotently and clears the closed handle", () => {
    directory = mkdtempSync(join(tmpdir(), "gh-migrate-db-"));
    initStore(join(directory, "store.sqlite"), []);
    const database = getDb();
    database.run("CREATE TABLE example (id INTEGER PRIMARY KEY)");

    addColumnIfMissing(database, "example", "label", "TEXT");
    addColumnIfMissing(database, "example", "label", "TEXT");
    expect(database.query("PRAGMA table_info(example)").all()).toHaveLength(2);

    closeStore();
    expect(() => getDb()).toThrow("Store not initialized");
  });
});
