import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTH_DURABLE_TABLES, authStore } from "./schema";

let database: Database | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

describe("auth schema", () => {
  test("creates every durable auth table at version three", () => {
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
    ).toEqual({ version: 3 });
  });

  test("reopens a v2 database without changing route IDs, user permissions or sessions", () => {
    const folder = mkdtempSync(join(tmpdir(), "dashboard-auth-v2-"));
    const path = join(folder, "dashboard.db");
    try {
      database = new Database(path);
      database.run("PRAGMA foreign_keys=ON");
      authStore.applySchema(database);
      database.run(`DROP TABLE self_service_grants; DROP TABLE self_service_routes;
        CREATE TABLE self_service_routes(id INTEGER PRIMARY KEY,source_provider TEXT,source_api_url TEXT,
          namespace TEXT COLLATE NOCASE,target_profile_id TEXT,target_api_url TEXT,target_org TEXT,
          UNIQUE(source_provider,source_api_url,namespace));
        CREATE TABLE self_service_grants(id TEXT PRIMARY KEY,route_id INTEGER REFERENCES self_service_routes(id),
          user_id TEXT REFERENCES app_users(id),can_migrate INTEGER,UNIQUE(user_id,route_id));
        UPDATE app_schema_versions SET version=2 WHERE domain='auth';
        INSERT INTO app_users(id,username,password_hash,role,created_at,updated_at) VALUES
          ('a','a','hash','operator','now','now'),('b','b','hash','operator','now','now');
        INSERT INTO app_sessions(token_hash,user_id,created_at,last_seen_at,expires_at) VALUES ('kept','a','now','now','later');
        INSERT INTO self_service_routes VALUES (41,'github','https://api.github.com','A','ghec','https://api.github.com','X');
        INSERT INTO self_service_grants VALUES ('legacy-reader',41,'a',0),('legacy-writer',41,'b',1);`);
      database.close();
      database = new Database(path);
      database.run("PRAGMA foreign_keys=ON");
      authStore.applySchema(database);
      authStore.applySchema(database);
      expect(
        database
          .query("SELECT id,route_id,user_id,can_migrate FROM self_service_grants ORDER BY id")
          .values(),
      ).toEqual([
        ["legacy-reader", 41, "a", 0],
        ["legacy-writer", 41, "b", 1],
      ]);
      expect(
        database.query("SELECT user_id FROM app_sessions WHERE token_hash='kept'").get(),
      ).toEqual({ user_id: "a" });
      const insert = database.prepare(
        "INSERT INTO self_service_routes SELECT ?,source_provider,source_api_url,namespace,target_profile_id,target_api_url,? FROM self_service_routes WHERE id=41",
      );
      insert.run(42, "Y");
      expect(() => insert.run(43, "Y")).toThrow();
      expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database?.close();
      database = undefined;
      rmSync(folder, { recursive: true, force: true });
    }
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
