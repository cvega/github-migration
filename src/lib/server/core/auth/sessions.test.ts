import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { authStore } from "./schema";
import {
  createSession,
  hashSessionToken,
  resolveSession,
  revokeSession,
  revokeUserSessions,
} from "./sessions";

let database: Database;

beforeEach(() => {
  database = new Database(":memory:");
  database.run("PRAGMA foreign_keys = ON");
  authStore.applySchema(database);
  database.run(`INSERT INTO app_users
    (id, username, password_hash, role, created_at, updated_at)
    VALUES ('user-1', 'admin', 'hash', 'admin', '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z')`);
});

afterEach(() => database.close());

describe("database sessions", () => {
  test("stores only the token digest and resolves the user", () => {
    const now = new Date("2026-08-29T12:00:00.000Z");
    const token = createSession("user-1", now, database);
    const stored = database.prepare("SELECT token_hash FROM app_sessions").get() as {
      token_hash: string;
    };

    expect(stored.token_hash).toBe(hashSessionToken(token));
    expect(stored.token_hash).not.toContain(token);
    expect(resolveSession(token, now, database)?.user.username).toBe("admin");
  });

  test("rejects expired, revoked, and disabled sessions", () => {
    const issued = new Date("2026-08-01T00:00:00.000Z");
    const expired = createSession("user-1", issued, database);
    expect(resolveSession(expired, new Date("2026-08-09T00:00:00.000Z"), database)).toBeNull();

    const active = createSession("user-1", new Date("2026-08-29T00:00:00.000Z"), database);
    revokeSession(active, new Date("2026-08-29T00:01:00.000Z"), database);
    expect(resolveSession(active, new Date("2026-08-29T00:02:00.000Z"), database)).toBeNull();

    const disabled = createSession("user-1", new Date("2026-08-29T00:03:00.000Z"), database);
    database.run("UPDATE app_users SET is_active = 0 WHERE id = 'user-1'");
    expect(resolveSession(disabled, new Date("2026-08-29T00:04:00.000Z"), database)).toBeNull();
  });

  test("limits a user to five concurrent sessions", () => {
    const tokens = Array.from({ length: 6 }, (_, index) =>
      createSession("user-1", new Date(Date.UTC(2026, 7, 29, 0, index)), database),
    );

    expect(
      resolveSession(tokens[0] ?? "", new Date("2026-08-29T01:00:00.000Z"), database),
    ).toBeNull();
    expect(
      resolveSession(tokens[5] ?? "", new Date("2026-08-29T01:00:00.000Z"), database),
    ).not.toBeNull();
  });

  test("revokes all sessions for a user", () => {
    const token = createSession("user-1", new Date("2026-08-29T00:00:00.000Z"), database);
    revokeUserSessions("user-1", new Date("2026-08-29T00:01:00.000Z"), database);
    expect(resolveSession(token, new Date("2026-08-29T00:02:00.000Z"), database)).toBeNull();
  });
});
