import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { AUTH_DURABLE_TABLES, authStore } from "./schema";

let database: Database | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

describe("auth schema", () => {
  test("creates every durable auth table at version one", () => {
    database = new Database(":memory:");
    database.run("PRAGMA foreign_keys = ON");
    authStore.applySchema(database);

    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const names = new Set(tables.map(({ name }) => name));

    for (const contract of AUTH_DURABLE_TABLES) expect(names.has(contract.name)).toBe(true);
    expect(
      database.prepare("SELECT version FROM app_schema_versions WHERE domain = 'auth'").get(),
    ).toEqual({ version: 1 });
  });

  test("enforces case-insensitive usernames and valid roles", () => {
    database = new Database(":memory:");
    database.run("PRAGMA foreign_keys = ON");
    authStore.applySchema(database);
    const insert = database.prepare(
      `INSERT INTO app_users
       (id, username, password_hash, role, created_at, updated_at)
       VALUES (?, ?, 'hash', ?, '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z')`,
    );

    insert.run("one", "Admin", "admin");
    expect(() => insert.run("two", "admin", "operator")).toThrow();
    expect(() => insert.run("three", "other", "viewer")).toThrow();
  });

  test("rejects sessions without a user", () => {
    database = new Database(":memory:");
    database.run("PRAGMA foreign_keys = ON");
    authStore.applySchema(database);

    expect(() =>
      database
        ?.prepare(
          `INSERT INTO app_sessions
         (token_hash, user_id, created_at, last_seen_at, expires_at)
         VALUES ('digest', 'missing', 'now', 'now', 'later')`,
        )
        .run(),
    ).toThrow();
  });
});
