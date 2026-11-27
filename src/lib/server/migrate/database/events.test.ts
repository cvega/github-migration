import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Migration, MigrationEvent } from "$lib/migrate/types";
import { closeStore, getDb, initStore } from "$lib/server/core/db";
import {
  eventDownloadPages,
  GLOBAL_EVENT_REPLAY_LIMIT,
  getEvents,
  getGlobalEventReplayWindow,
  getMigrationEventReplayWindow,
  getRecentActivity,
  insertEvent,
} from "./events";
import { insertMigration } from "./migrations";
import { migrateStore } from "./schema";

beforeEach(() => initStore(":memory:", [migrateStore]));
afterEach(closeStore);

function insertOwner(id = "migration-1"): void {
  const migration: Migration = {
    id,
    batchId: null,
    githubMigrationId: null,
    sourceProvider: "github",
    sourceApiUrl: "https://api.github.com",
    targetProfileId: "ghec",
    targetPlatform: "ghec",
    targetApiUrl: "https://api.github.com",
    sourceOrg: "acme",
    sourceRepo: id,
    targetOrg: "acme-cloud",
    targetRepo: id,
    state: "running",
    failureReason: null,
    migrationLogUrl: null,
    warningsCount: 0,
    sourceCounts: null,
    targetCounts: null,
    sourceSizeKb: null,
    startedAt: "2026-08-17T12:00:00.000Z",
    completedAt: null,
    elapsedSeconds: null,
    authMode: "env-pat",
    requestOptions: "{}",
  };
  insertMigration(migration);
}

function banner(migrationId: string, message: string, createdAt: string): MigrationEvent {
  return {
    id: 0,
    migrationId,
    eventType: "banner",
    phase: null,
    payload: { message },
    createdAt,
  };
}

describe("migration event persistence", () => {
  test("reads migration events in ID order after an optional cursor", () => {
    insertOwner();
    const first = insertEvent(banner("migration-1", "first", "2026-08-17T12:00:01Z"));
    const second = insertEvent(banner("migration-1", "second", "2026-08-17T12:00:02Z"));
    expect(getEvents("migration-1").map(({ id }) => id)).toEqual([first, second]);
    expect(getEvents("migration-1", first).map(({ id }) => id)).toEqual([second]);
  });

  test("freezes replay high water and reports a cursor ahead of it", () => {
    insertOwner();
    const id = insertEvent(banner("migration-1", "ready", "2026-08-17T12:00:01Z"));
    expect(getMigrationEventReplayWindow("migration-1", 0)).toMatchObject({
      highWater: id,
      stale: null,
      replayFrom: id,
    });
    expect(getGlobalEventReplayWindow(id + 1)).toMatchObject({
      highWater: id,
      stale: "cursor_ahead",
      events: [],
    });
  });

  test("returns only the newest bounded replay tail", () => {
    insertOwner();
    for (let index = 0; index <= GLOBAL_EVENT_REPLAY_LIMIT; index += 1) {
      insertEvent(banner("migration-1", `event-${index}`, "2026-08-17T12:00:01Z"));
    }
    const replay = getGlobalEventReplayWindow(0);
    expect(replay.stale).toBe("replay_limit");
    expect(replay.events).toHaveLength(GLOBAL_EVENT_REPLAY_LIMIT);
    expect(replay.replayFrom).toBe(2);
  });

  test("skips a legacy malformed failure event across history readers", () => {
    insertOwner();
    const first = insertEvent(banner("migration-1", "first", "2026-08-17T12:00:01Z"));
    getDb().run(
      "INSERT INTO events (migration_id, event_type, payload, created_at) VALUES (?, ?, ?, ?)",
      [
        "migration-1",
        "failure",
        JSON.stringify({
          detail: {
            migrationId: "migration-1",
            state: "FAILED",
            failureReason: "Import failed",
            elapsed: 1,
            logUrl: "",
            logEntries: [{ severity: "ERROR", message: 1, modelName: "Repository" }],
          },
        }),
        "2026-08-17T12:00:02Z",
      ],
    );
    const last = insertEvent(banner("migration-1", "last", "2026-08-17T12:00:03Z"));
    expect(getEvents("migration-1").map(({ id }) => id)).toEqual([first, last]);
    expect(getGlobalEventReplayWindow(0).events.map(({ id }) => id)).toEqual([first, last]);
    expect(getMigrationEventReplayWindow("migration-1", first).events.map(({ id }) => id)).toEqual([
      last,
    ]);
    expect([...eventDownloadPages("migration-1")].flat().map(({ id }) => id)).toEqual([
      first,
      last,
    ]);
    expect(getRecentActivity().map(({ id }) => id)).toEqual([last, first]);
  });

  test("projects recent failure and restart activity", () => {
    insertOwner();
    insertEvent({
      id: 0,
      migrationId: "migration-1",
      eventType: "failure",
      phase: null,
      payload: { error: "archive failed" },
      createdAt: "2026-08-17T12:00:01Z",
    });
    insertEvent({
      id: 0,
      migrationId: "migration-1",
      eventType: "restart",
      phase: null,
      payload: { message: "Restart requested" },
      createdAt: "2026-08-17T12:00:02Z",
    });
    expect(getRecentActivity()).toMatchObject([
      { kind: "restarted", repo: "acme/migration-1", summary: "Restart requested" },
      { kind: "failed", repo: "acme/migration-1", summary: "archive failed" },
    ]);
  });
});
