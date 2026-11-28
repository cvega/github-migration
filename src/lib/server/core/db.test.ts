import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkStoreReady, closeStore, enableWal, getDb, initStore } from "./db";

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
        version: 1,
        tables: [],
        domain: "a",
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
        version: 1,
        tables: [],
        domain: "b",
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
    expect(getDb().query("PRAGMA foreign_keys").get()).toEqual({
      foreign_keys: 1,
    });
  });

  test("rolls back every fresh schema and baseline when a later domain fails", () => {
    directory = mkdtempSync(join(tmpdir(), "gh-migrate-db-"));
    const path = join(directory, "store.sqlite");
    closeStore();
    expect(() =>
      initStore(path, [
        {
          domain: "first",
          version: 1,
          tables: [],
          applySchema(database) {
            database.run("CREATE TABLE first_table (id INTEGER)");
          },
        },
        {
          domain: "second",
          version: 1,
          tables: [],
          applySchema() {
            throw new Error("DDL failed");
          },
        },
      ]),
    ).toThrow("DDL failed");
    expect(() => getDb()).toThrow("Store not initialized");
    using reopened = new Database(path);
    expect(reopened.query("SELECT name FROM sqlite_schema").all()).toEqual([]);
    initStore(path, []);
    checkStoreReady();
  });

  test("a failed startup hook releases its connection and preserves the active handle", () => {
    directory = mkdtempSync(join(tmpdir(), "gh-migrate-db-"));
    initStore(":memory:", []);
    const active = getDb();
    const path = join(directory, "store.sqlite");
    expect(() =>
      initStore(
        path,
        [
          {
            domain: "fixture",
            version: 1,
            tables: [],
            applySchema() {},
            onInit(database) {
              database.run("BEGIN IMMEDIATE");
              throw new Error("startup failed");
            },
          },
        ],
        {},
      ),
    ).toThrow("startup failed");
    expect(getDb()).toBe(active);
    using reopened = new Database(path);
    reopened.run("BEGIN IMMEDIATE");
    reopened.run("ROLLBACK");
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

  test("clears the closed handle", () => {
    directory = mkdtempSync(join(tmpdir(), "gh-migrate-db-"));
    initStore(join(directory, "store.sqlite"), []);
    closeStore();
    expect(() => getDb()).toThrow("Store not initialized");
  });
});

describe("enableWal", () => {
  function peerHoldingWriteLock() {
    directory = mkdtempSync(join(tmpdir(), "gh-migrate-wal-"));
    const path = join(directory, "store.sqlite");
    const peer = new Database(path, { create: true });
    peer.run("CREATE TABLE t (id INTEGER)");
    const database = new Database(path);
    database.run("PRAGMA busy_timeout = 5000");
    peer.run("BEGIN IMMEDIATE");
    return { peer, database };
  }

  test("retries until a peer's write lock is released", () => {
    const { peer, database } = peerHoldingWriteLock();
    using _peer = peer;
    using _database = database;
    let sleeps = 0;
    enableWal(database, {
      sleep() {
        if (++sleeps === 3) peer.run("COMMIT");
      },
    });
    expect(sleeps).toBe(3);
    expect(database.query("PRAGMA journal_mode").values()).toEqual([["wal"]]);
  });

  test("surfaces the busy error once the timeout has elapsed", () => {
    const { peer, database } = peerHoldingWriteLock();
    using _peer = peer;
    using _database = database;
    let clock = 0;
    const waits: number[] = [];
    expect(() =>
      enableWal(database, {
        timeoutMs: 50,
        now: () => clock,
        sleep(ms) {
          waits.push(ms);
          clock += ms;
        },
      }),
    ).toThrow("database is locked");
    expect(waits.reduce((sum, ms) => sum + ms, 0)).toBeGreaterThanOrEqual(50);
    expect(database.query("PRAGMA journal_mode").values()).toEqual([["delete"]]);
  });

  test("does not retry errors other than SQLITE_BUSY", () => {
    directory = mkdtempSync(join(tmpdir(), "gh-migrate-wal-"));
    using database = new Database(join(directory, "store.sqlite"), {
      create: true,
    });
    database.close();
    let sleeps = 0;
    expect(() =>
      enableWal(database, {
        sleep() {
          sleeps++;
        },
      }),
    ).toThrow();
    expect(sleeps).toBe(0);
  });
});
