import { beforeEach, describe, expect, test } from "bun:test";
import type { Migration, MigrationEvent } from "$lib/migrate/types";
import { eventChangesBatchSummary, patchMigrationFromEvent } from "./events";

const counts = {
  commits: 10,
  branches: 2,
  tags: 3,
  issues: 4,
  pullRequests: 5,
  releases: 6,
};

function progress(logUrl = "https://example.test/migration.log") {
  return {
    current: {
      timestamp: "2026-08-08T01:00:00.000Z",
      migrationState: "IMPORTING_METADATA",
      failureReason: "",
      migrationLogUrl: logUrl,
      warningsCount: 7,
      repoExists: true,
      countsAuthoritative: true,
      repoSize: 100,
      ...counts,
      phase: "IMPORTING_METADATA" as const,
      elapsed: 20,
    },
    previous: null,
    deltaCommits: 10,
    deltaBranches: 2,
    deltaTags: 3,
    deltaIssues: 4,
    deltaPRs: 5,
    deltaReleases: 6,
    deltaSize: 100,
    commitsPerMin: 30,
    issuesPerMin: 12,
  };
}

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
    sourceOrg: "source",
    sourceRepo: id,
    targetOrg: "target",
    targetRepo: id,
    state: "running",
    failureReason: null,
    migrationLogUrl: null,
    warningsCount: 0,
    sourceCounts: null,
    targetCounts: null,
    sourceSizeKb: null,
    startedAt: "2026-08-08T00:00:00.000Z",
    completedAt: null,
    elapsedSeconds: null,
    authMode: null,
    requestOptions: null,
  };
}

let page: Migration[];

beforeEach(() => {
  page = [migration("page-2-a"), migration("page-2-b")];
});

describe("patchMigrationFromEvent", () => {
  test("promotes pending work and applies source counts from step events", () => {
    const pending = { ...migration("pending"), state: "pending" as const };
    const event: MigrationEvent = {
      migrationId: pending.id,
      eventType: "step",
      phase: null,
      payload: { message: "Archive ready", counts },
      createdAt: "2026-08-08T01:00:00.000Z",
    };

    expect(patchMigrationFromEvent(pending, event)).toMatchObject({
      state: "running",
      sourceCounts: counts,
    });
  });

  test("applies snapshots without changing terminal fields", () => {
    const current = { ...migration("snapshot"), migrationLogUrl: "existing.log" };
    const event: MigrationEvent = {
      migrationId: current.id,
      eventType: "snapshot",
      phase: "IMPORTING_METADATA",
      payload: { progress: progress(""), sourceCounts: counts },
      createdAt: "2026-08-08T01:00:00.000Z",
    };

    expect(patchMigrationFromEvent(current, event)).toMatchObject({
      state: "running",
      sourceCounts: counts,
      targetCounts: counts,
      warningsCount: 7,
      migrationLogUrl: "existing.log",
      completedAt: null,
      elapsedSeconds: null,
    });
  });

  test("completes migrations from the final progress snapshot", () => {
    const current = migration("complete");
    const event: MigrationEvent = {
      migrationId: current.id,
      eventType: "complete",
      phase: "SUCCEEDED",
      payload: { progress: progress(), sourceCounts: counts, elapsed: 42 },
      createdAt: "2026-08-08T01:00:00.000Z",
    };

    expect(patchMigrationFromEvent(current, event)).toMatchObject({
      state: "succeeded",
      targetCounts: counts,
      warningsCount: 7,
      migrationLogUrl: "https://example.test/migration.log",
      completedAt: event.createdAt,
      elapsedSeconds: 42,
    });
  });

  test("patches a visible terminal row without replacing page membership or order", () => {
    const event: MigrationEvent = {
      id: 42,
      migrationId: "page-2-b",
      eventType: "failure",
      phase: "FAILED",
      payload: { error: "Import failed" },
      createdAt: "2026-08-08T01:00:00.000Z",
    };

    page = page.map((item) => patchMigrationFromEvent(item, event));

    expect(page.map((item) => item.id)).toEqual(["page-2-a", "page-2-b"]);
    expect(page[1]?.state).toBe("failed");
    expect(page[1]?.failureReason).toBe("Import failed");
  });

  test("prefers structured failure detail over summary prose", () => {
    const current = migration("structured-failure");
    const event: MigrationEvent = {
      migrationId: current.id,
      eventType: "failure",
      phase: "FAILED",
      payload: {
        error: "Import failed",
        detail: {
          migrationId: current.id,
          state: "FAILED",
          failureReason: "Target repository rule rejected the import",
          elapsed: 11,
          logUrl: "https://example.test/failure.log",
          logEntries: [],
        },
      },
      createdAt: "2026-08-08T01:00:00.000Z",
    };

    expect(patchMigrationFromEvent(current, event).failureReason).toBe(
      "Target repository rule rejected the import",
    );
  });

  test("ignores events for migrations outside the loaded page", () => {
    const before = page;
    const event: MigrationEvent = {
      id: 43,
      migrationId: "page-1-only",
      eventType: "step",
      phase: null,
      payload: { message: "Started" },
      createdAt: "2026-08-08T01:00:00.000Z",
    };

    page = page.map((item) => patchMigrationFromEvent(item, event));

    expect(page).toEqual(before);
  });
});

test("only terminal events require an authoritative batch summary refresh", () => {
  const event = (eventType: MigrationEvent["eventType"]) => ({ eventType });

  expect(eventChangesBatchSummary(event("complete"))).toBe(true);
  expect(eventChangesBatchSummary(event("failure"))).toBe(true);
  expect(eventChangesBatchSummary(event("snapshot"))).toBe(false);
  expect(eventChangesBatchSummary(event("step"))).toBe(false);
});
