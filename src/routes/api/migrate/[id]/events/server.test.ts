import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Migration } from "$lib/migrate/types";
import { closeStore, initStore } from "$lib/server/core/db";
import { insertEvent } from "$lib/server/migrate/database/events";
import { insertMigration } from "$lib/server/migrate/database/migrations";
import { migrateStore } from "$lib/server/migrate/database/schema";
import { GET } from "./+server";

function completedMigration(): Migration {
  return {
    id: "completed",
    batchId: null,
    githubMigrationId: null,
    sourceProvider: "github",
    sourceApiUrl: "https://api.github.com",
    targetProfileId: "ghec",
    targetPlatform: "ghec",
    targetApiUrl: "https://api.github.com",
    sourceOrg: "source",
    sourceRepo: "repository",
    targetOrg: "target",
    targetRepo: "repository",
    state: "succeeded",
    failureReason: null,
    migrationLogUrl: null,
    warningsCount: 0,
    sourceCounts: null,
    targetCounts: null,
    sourceSizeKb: null,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    elapsedSeconds: 1,
    authMode: "env-pat",
    requestOptions: "{}",
  };
}

function eventRequest(id: string, query = "") {
  const url = new URL(`http://localhost/api/migrate/${id}/events${query}`);
  return { params: { id }, url, request: new Request(url) } as never;
}

beforeEach(() => {
  initStore(":memory:", [migrateStore]);
  insertMigration(completedMigration());
});
afterEach(closeStore);

describe("migration event stream", () => {
  test("downloads the full ordered run history without later or unrelated events", async () => {
    insertMigration({ ...completedMigration(), id: "other" });
    const add = (migrationId: string, index: number) =>
      insertEvent({
        migrationId,
        eventType: "step",
        phase: null,
        createdAt: "2026-01-01T00:00:00Z",
        payload: { message: `message ${index}` },
      });
    for (let i = 0; i < 1005; i++) add("completed", i);
    add("other", -1);
    const response = await GET(eventRequest("completed", "?download=1"));
    add("completed", 1005);
    expect(response.headers.get("content-disposition")).toContain(
      'filename="migration-completed-events.ndjson"',
    );
    const events = (await response.text())
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.length).toBe(1005);
    expect(
      events.every(
        (event, i) => event.migrationId === "completed" && event.payload.message === `message ${i}`,
      ),
    ).toBe(true);
  });
  test("returns 404 for an unknown migration and 400 for an invalid cursor", async () => {
    expect((await GET(eventRequest("missing"))).status).toBe(404);
    expect((await GET(eventRequest("completed", "?after=-1"))).status).toBe(400);
  });

  test("closes a terminal migration stream with a done frame", async () => {
    const response = await GET(eventRequest("completed"));
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const frames = await response.text();
    expect(frames).toContain('"type":"done"');
  });
});
