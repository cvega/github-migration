import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Migration, MigrationEvent, Progress } from "$lib/migrate/types";
import { closeStore, initStore } from "$lib/server/core/db";
import { getEvents } from "../database/events";
import { getMigration, insertMigration, updateMigrationState } from "../database/migrations";
import { migrateStore } from "../database/schema";
import { activeMigrationRuns } from "./active";
import {
  broadcastMigrationEvent,
  closeMigrationEventStream,
  createMigrationEventHandler,
  subscribeToGlobalMigrationEvents,
  subscribeToMigrationEvents,
} from "./events";

beforeEach(() => initStore(":memory:", [migrateStore]));
afterEach(closeStore);

function migration(id: string): Migration {
  return {
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
    state: "pending",
    failureReason: null,
    migrationLogUrl: null,
    warningsCount: 0,
    sourceCounts: null,
    targetCounts: null,
    sourceSizeKb: null,
    startedAt: "2026-08-18T12:00:00.000Z",
    completedAt: null,
    elapsedSeconds: null,
    authMode: null,
    requestOptions: null,
  };
}

function step(id: string, message = "Export started"): MigrationEvent {
  return {
    migrationId: id,
    eventType: "step",
    phase: null,
    payload: { message },
    createdAt: "2026-08-18T12:00:01.000Z",
  };
}

describe("migration event projection", () => {
  test("persists, projects, and broadcasts an accepted event", () => {
    insertMigration(migration("migration-1"));
    const registration = activeMigrationRuns.claim("migration-1");
    if (!registration) throw new Error("run was not claimed");
    const frames: string[] = [];
    const unsubscribe = subscribeToMigrationEvents("migration-1", {
      enqueue: (frame: string) => frames.push(frame),
    } as unknown as ReadableStreamDefaultController<string>);
    try {
      createMigrationEventHandler("migration-1", registration.token)(step("migration-1"));
      expect(getMigration("migration-1")?.state).toBe("running");
      expect(getEvents("migration-1")).toHaveLength(1);
      expect(frames[0]).toContain("Export started");
      expect(frames[0]).toStartWith("id: 1\n");
    } finally {
      unsubscribe();
      activeMigrationRuns.finish("migration-1", registration.token);
    }
  });

  test("ignores events from a stale run token", () => {
    insertMigration(migration("migration-1"));
    const stale = activeMigrationRuns.claim("migration-1");
    if (!stale) throw new Error("run was not claimed");
    activeMigrationRuns.finish("migration-1", stale.token);
    const current = activeMigrationRuns.claim("migration-1");
    if (!current) throw new Error("replacement run was not claimed");
    try {
      createMigrationEventHandler("migration-1", stale.token)(step("migration-1"));
      expect(getEvents("migration-1")).toEqual([]);
      expect(getMigration("migration-1")?.state).toBe("pending");
    } finally {
      activeMigrationRuns.finish("migration-1", current.token);
    }
  });

  test("requires reconciliation when failure arrives during cancellation", () => {
    insertMigration(migration("migration-1"));
    const registration = activeMigrationRuns.claim("migration-1");
    if (!registration) throw new Error("run was not claimed");
    updateMigrationState("migration-1", "cancelling");
    try {
      createMigrationEventHandler(
        "migration-1",
        registration.token,
      )({
        migrationId: "migration-1",
        eventType: "failure",
        phase: "FAILED",
        payload: { error: "remote failure" },
        createdAt: "2026-08-18T12:00:02.000Z",
      });
      expect(getMigration("migration-1")).toMatchObject({
        state: "reconciliation_required",
        failureReason: "Migration settled remotely while cancellation was pending",
      });
    } finally {
      activeMigrationRuns.finish("migration-1", registration.token);
    }
  });

  test("clears a partial target snapshot when final counts are unavailable", () => {
    insertMigration(migration("migration-1"));
    const counts = { commits: 10, branches: 1, tags: 1, issues: 2, pullRequests: 3, releases: 1 };
    updateMigrationState("migration-1", "running", { targetCounts: counts });
    const registration = activeMigrationRuns.claim("migration-1");
    if (!registration) throw new Error("run was not claimed");
    const current: Progress["current"] = {
      timestamp: "2026-08-18T12:05:00.000Z",
      migrationState: "SUCCEEDED",
      failureReason: "",
      migrationLogUrl: "",
      warningsCount: 0,
      repoExists: true,
      countsAuthoritative: false,
      repoSize: 0,
      ...counts,
      phase: "SUCCEEDED",
      elapsed: 300,
    };
    const progress: Progress = {
      current,
      previous: null,
      deltaCommits: 0,
      deltaBranches: 0,
      deltaTags: 0,
      deltaIssues: 0,
      deltaPRs: 0,
      deltaReleases: 0,
      deltaSize: 0,
      commitsPerMin: 0,
      issuesPerMin: 0,
    };
    try {
      createMigrationEventHandler(
        "migration-1",
        registration.token,
      )({
        migrationId: "migration-1",
        eventType: "complete",
        phase: "SUCCEEDED",
        payload: { progress, sourceCounts: null, elapsed: 300 },
        createdAt: current.timestamp,
      });
      expect(getMigration("migration-1")).toMatchObject({ state: "succeeded", targetCounts: null });
    } finally {
      activeMigrationRuns.finish("migration-1", registration.token);
    }
  });
});

test("terminal stream closure does not close global subscribers", () => {
  const migrationFrames: string[] = [];
  const globalFrames: string[] = [];
  let migrationClosed = false;
  subscribeToMigrationEvents("migration-1", {
    enqueue: (frame: string) => migrationFrames.push(frame),
    close: () => {
      migrationClosed = true;
    },
  } as unknown as ReadableStreamDefaultController<string>);
  const unsubscribeGlobal = subscribeToGlobalMigrationEvents({
    enqueue: (frame: string) => globalFrames.push(frame),
  } as unknown as ReadableStreamDefaultController<string>);
  try {
    closeMigrationEventStream("migration-1", "succeeded");
    broadcastMigrationEvent("migration-2", step("migration-2"));
    expect(migrationFrames).toEqual(['data: {"type":"done","state":"succeeded"}\n\n']);
    expect(migrationClosed).toBe(true);
    expect(globalFrames).toHaveLength(1);
  } finally {
    unsubscribeGlobal();
  }
});
