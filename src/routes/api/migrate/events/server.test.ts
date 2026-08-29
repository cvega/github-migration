import { beforeEach, describe, expect, test } from "bun:test";
import type { Migration, MigrationEvent } from "$lib/migrate/types";
import { initStore } from "$lib/server/core/db";
import { insertEvent } from "$lib/server/migrate/database/events";
import { insertMigration } from "$lib/server/migrate/database/migrations";
import { DOMAIN_STORES } from "$lib/server/schemas";
import { GET } from "./+server";

const baseMigration: Migration = {
  id: "global-sse-1",
  batchId: null,
  githubMigrationId: null,
  sourceProvider: "github",
  sourceApiUrl: "https://api.github.com",
  targetProfileId: "ghec",
  targetPlatform: "ghec",
  targetApiUrl: "https://api.github.com",
  sourceOrg: "acme",
  sourceRepo: "one",
  targetOrg: "acme-cloud",
  targetRepo: "one",
  state: "running",
  failureReason: null,
  migrationLogUrl: null,
  warningsCount: 0,
  sourceCounts: null,
  targetCounts: null,
  sourceSizeKb: null,
  startedAt: "2026-08-07T12:00:00.000Z",
  completedAt: null,
  elapsedSeconds: null,
  authMode: null,
  requestOptions: null,
};

type GetArgs = Parameters<typeof GET>[0];

function request(after?: string): GetArgs {
  const url = new URL("http://localhost/api/migrate/events");
  if (after !== undefined) url.searchParams.set("after", after);
  return { url, request: new Request(url) } as unknown as GetArgs;
}

function event(migrationId: string, message: string): MigrationEvent {
  return {
    migrationId,
    eventType: "step",
    phase: null,
    payload: { message },
    createdAt: "2026-08-07T12:00:00.000Z",
  };
}

beforeEach(() => {
  initStore(":memory:", DOMAIN_STORES);
  insertMigration(baseMigration);
  insertMigration({
    ...baseMigration,
    id: "global-sse-2",
    sourceRepo: "two",
    targetRepo: "two",
  });
});

describe("GET global migration events", () => {
  test("rejects malformed replay cursors", async () => {
    const response = await GET(request("2junk"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Invalid "after" / Last-Event-ID - must be a non-negative integer',
    });
  });

  test("replays newer events from every migration", async () => {
    const firstId = insertEvent(event("global-sse-1", "first"));
    const secondId = insertEvent(event("global-sse-2", "second"));

    const response = await GET(request(String(firstId)));
    const reader = response.body?.getReader();
    const frame = await reader?.read();
    await reader?.cancel();
    const chunk: unknown = frame?.value;
    const body = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk as Uint8Array);

    expect(response.status).toBe(200);
    expect(body).not.toContain('"message":"first"');
    expect(body).toContain(`id: ${secondId}`);
    expect(body).toContain('"message":"second"');
  });
});
