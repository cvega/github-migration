import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Migration, MigrationEvent } from "$lib/migrate/types";

(globalThis as unknown as { $state: <Value>(value: Value) => Value }).$state = (value) => value;

const eventSources: FakeEventSource[] = [];

class FakeEventSource {
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  readonly listeners = new Map<string, (event: MessageEvent) => void>();

  constructor(readonly url: string) {
    eventSources.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.set(type, listener);
  }

  emitMessage(value: unknown): void {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(value) }));
  }

  emitRaw(data: string): void {
    this.onmessage?.(new MessageEvent("message", { data }));
  }

  emitControl(type: string, value: unknown): void {
    this.listeners.get(type)?.(new MessageEvent(type, { data: JSON.stringify(value) }));
  }

  close(): void {
    this.closed = true;
  }
}

const originalEventSource = globalThis.EventSource;
const originalFetch = globalThis.fetch;
(globalThis as unknown as { EventSource: typeof FakeEventSource }).EventSource = FakeEventSource;

const { createGlobalEventSource, createMigrationEventSource, migrations, refreshMigrations } =
  await import("./live.svelte");

function migration(state: Migration["state"] = "pending"): Migration {
  return {
    id: "migration-1",
    batchId: null,
    githubMigrationId: null,
    sourceProvider: "github",
    sourceApiUrl: "https://api.github.com",
    targetProfileId: "ghec",
    targetPlatform: "ghec",
    targetApiUrl: "https://api.github.com",
    sourceOrg: "acme",
    sourceRepo: "widgets",
    targetOrg: "acme-cloud",
    targetRepo: "widgets",
    state,
    failureReason: null,
    migrationLogUrl: null,
    warningsCount: 0,
    sourceCounts: null,
    targetCounts: null,
    sourceSizeKb: null,
    startedAt: "2026-08-17T12:00:00.000Z",
    completedAt: null,
    elapsedSeconds: null,
    authMode: null,
    requestOptions: null,
  };
}

function event(eventType: "step" | "failure", id: number): MigrationEvent {
  const base = {
    id,
    migrationId: "migration-1",
    phase: null,
    createdAt: "2026-08-17T12:00:01.000Z",
  };
  return eventType === "step"
    ? { ...base, eventType, payload: { message: "Archive ready" } }
    : { ...base, eventType, payload: { error: "Import failed" } };
}

beforeEach(() => {
  eventSources.length = 0;
  migrations.value = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

describe("migration live state", () => {
  test("refreshes the paginated collection from the approved API", async () => {
    const requests: string[] = [];
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      requests.push(input.toString());
      return Response.json({ data: [{ id: "migration-1" }], total: 1 });
    }) as unknown as typeof fetch;

    expect(await refreshMigrations()).toBe(true);
    expect(requests).toEqual(["/api/migrate"]);
    expect(migrations.value.map(({ id }) => id)).toEqual(["migration-1"]);
  });

  test("preserves current rows when refresh fails", async () => {
    migrations.value = [migration()];
    globalThis.fetch = mock(
      async () => new Response(null, { status: 503 }),
    ) as unknown as typeof fetch;
    expect(await refreshMigrations()).toBe(false);
    expect(migrations.value).toHaveLength(1);

    globalThis.fetch = mock(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await refreshMigrations()).toBe(false);
    expect(migrations.value).toHaveLength(1);
  });

  test("opens approved per-migration and global replay streams", () => {
    const migrationStream = createMigrationEventSource("migration-1", 41);
    const globalStream = createGlobalEventSource();

    expect(eventSources.map(({ url }) => url)).toEqual([
      "/api/migrate/migration-1/events?after=41",
      "/api/migrate/events",
    ]);

    migrationStream.destroy();
    globalStream.destroy();
    expect(eventSources.every(({ closed }) => closed)).toBe(true);
  });

  test("keeps lifecycle events after a terminal event until the done frame", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ data: [migration("failed")], total: 1 }),
    ) as unknown as typeof fetch;
    const stream = createMigrationEventSource("migration-1", 10);
    const source = eventSources[0]!;

    source.onopen?.();
    expect(stream.connected).toBe(true);
    source.emitMessage(event("step", 11));
    source.emitRaw("not-json");
    expect(stream.events).toHaveLength(1);

    source.emitControl("cursor-stale", { highWater: 15 });
    source.emitMessage(event("failure", 16));
    await Promise.resolve();
    expect(stream.events).toHaveLength(2);
    expect(source.closed).toBe(false);
    source.emitMessage(event("step", 17));
    source.emitMessage({ type: "done", state: "reconciliation_required" });
    expect(stream.events).toHaveLength(3);
    expect(source.closed).toBe(true);
    expect(stream.connected).toBe(false);

    const doneStream = createMigrationEventSource("migration-1", 0);
    const doneSource = eventSources.at(-1)!;
    expect(doneSource.url).toBe("/api/migrate/migration-1/events?after=0");
    doneSource.emitControl("cursor-stale", "malformed");
    doneSource.emitMessage({ type: "done", state: "succeeded" });
    expect(doneSource.closed).toBe(true);
    doneStream.destroy();
  });

  test("patches global rows, exposes connection state, and reconnects on demand", async () => {
    migrations.value = [migration()];
    globalThis.fetch = mock(async () =>
      Response.json({ data: migrations.value, total: 1 }),
    ) as unknown as typeof fetch;
    const stream = createGlobalEventSource();
    const source = eventSources[0]!;

    source.onopen?.();
    expect(stream.connected).toBe(true);
    expect(stream.stale).toBe(false);

    source.emitMessage(event("step", 21));
    source.emitRaw("not-json");
    expect(stream.events).toHaveLength(1);
    expect(migrations.value[0]?.state).toBe("running");

    source.emitControl("cursor-stale", { highWater: 25 });
    stream.retry();
    await Promise.resolve();
    expect(source.closed).toBe(true);
    expect(eventSources.at(-1)?.url).toBe("/api/migrate/events?after=25");

    stream.destroy();
    expect(eventSources.at(-1)?.closed).toBe(true);
    expect(stream.connected).toBe(false);
  });
});

afterAll(() => {
  globalThis.EventSource = originalEventSource;
});
