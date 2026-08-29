import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { listAuditEvents, recordAuditEvent, recordOperatorAuditEvent } from "./audit";
import { authStore } from "./schema";

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

describe("audit events", () => {
  test("joins actor and target names without exposing metadata", () => {
    recordAuditEvent(
      {
        actorUserId: "user-1",
        targetUserId: "user-1",
        action: "auth.password.reset",
        metadata: { privateDetail: "not returned" },
        createdAt: new Date("2026-08-29T12:00:00.000Z"),
      },
      database,
    );

    expect(listAuditEvents(10, database)).toEqual([
      {
        id: 1,
        actorUsername: "admin",
        action: "auth.password.reset",
        resourceType: null,
        resourceId: null,
        targetUsername: "admin",
        ipAddress: null,
        createdAt: "2026-08-29T12:00:00.000Z",
      },
    ]);
  });

  test("skips only synthetic handler calls without locals", () => {
    recordOperatorAuditEvent(undefined, { action: "migration.started" }, database);
    recordOperatorAuditEvent(
      { authEnabled: false },
      { action: "migration.started", resourceId: "migration-1" },
      database,
    );
    expect(listAuditEvents(10, database)).toHaveLength(1);
    expect(listAuditEvents(10, database)[0]?.actorUsername).toBeNull();
  });
});
