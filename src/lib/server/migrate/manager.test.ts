import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Migration } from "$lib/migrate/types";
import { closeStore, initStore } from "$lib/server/core/db";
import { getEvents } from "./database/events";
import { getMigration, insertMigration } from "./database/migrations";
import { migrateStore } from "./database/schema";
import { getRegisteredMigrationExecutor } from "./executors/registry";
import {
  cancel,
  confirmRestart,
  MAX_CONCURRENT_MIGRATIONS,
  restart,
  restartBatch,
  start,
  startBatch,
} from "./manager";

function migration(id: string, state: Migration["state"]): Migration {
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
    state,
    failureReason: null,
    migrationLogUrl: null,
    warningsCount: 0,
    sourceCounts: null,
    targetCounts: null,
    sourceSizeKb: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    elapsedSeconds: null,
    authMode: null,
    requestOptions: null,
  };
}

beforeEach(() => initStore(":memory:", [migrateStore]));
afterEach(closeStore);

describe("migration manager", () => {
  test.each(["omitted GHES", "explicit GHES", "cloud"])(
    "executes and restarts the admitted %s host and options",
    async (scenario) => {
      const prior = process.env.GH_SOURCE_API_URL;
      const priorToken = process.env.GH_SOURCE_PAT;
      const host =
        scenario === "cloud" ? "https://api.github.com" : "https://source.example/api/v3";
      process.env.GH_SOURCE_API_URL = host;
      process.env.GH_SOURCE_PAT = "server-fixture";
      const executor = getRegisteredMigrationExecutor({
        sourceProvider: "github",
        targetPlatform: "ghec",
      });
      using run = spyOn(executor, "run").mockImplementation(async ({ id }) => ({
        ...getMigration(id!)!,
        state: "failed",
      }));
      try {
        const job = start({
          sourceRepo: "org/repo",
          targetOrg: "dest",
          sourceApiUrl: scenario === "explicit GHES" ? host : undefined,
          skipReleases: true,
          targetRepoVisibility: "private",
          sourceToken: scenario === "explicit GHES" ? "fixture" : undefined,
          targetToken: "fixture",
        });
        await Bun.sleep(0);
        expect(JSON.parse(getMigration(job.id)!.requestOptions!)).toMatchObject({
          sourceApiUrl: host,
          skipReleases: true,
          targetRepoVisibility: "private",
        });
        restart(job.id, { sourceToken: "fresh-fixture", targetToken: "fresh-fixture" });
        await Bun.sleep(0);
        expect(run).toHaveBeenCalledTimes(2);
        for (const [request] of run.mock.calls)
          expect(request).toMatchObject({
            sourceApiUrl: host,
            skipReleases: true,
            targetRepoVisibility: "private",
          });
        expect(getMigration(job.id)?.requestOptions).not.toContain("fixture");
      } finally {
        if (prior === undefined) delete process.env.GH_SOURCE_API_URL;
        else process.env.GH_SOURCE_API_URL = prior;
        if (priorToken === undefined) delete process.env.GH_SOURCE_PAT;
        else process.env.GH_SOURCE_PAT = priorToken;
      }
    },
  );
  test.each([
    ["ghes", "ghec", "https://api.github.com"],
    ["ghec", "enterprise", "https://api.github.com"],
    ["ghec", "ghec", "https://enterprise.example/api/v3"],
  ] as const)(
    "blocks restarts before resetting conflicting GitLab route %s/%s/%s",
    (targetPlatform, targetProfileId, targetApiUrl) => {
      const record: Migration = {
        ...migration("paused", "failed"),
        sourceProvider: "gitlab",
        targetPlatform,
        targetProfileId,
        targetApiUrl,
        batchId: "batch",
      };
      insertMigration(record);
      expect(() => restart(record.id, {})).toThrow("paused");
      expect(restartBatch("batch", {})).toMatchObject({
        restarted: 0,
        errors: [{ id: record.id, error: expect.stringContaining("paused") }],
      });
      expect(getMigration(record.id)?.state).toBe("failed");
      expect(getEvents(record.id)).toEqual([]);
    },
  );

  test("rejects direct and batch starts for a custom GitLab GHES profile", () => {
    const env = { ...process.env };
    try {
      process.env.GHES_TARGET_ID = "enterprise";
      process.env.GHES_TARGET_API_URL = "https://enterprise.example";
      const request = {
        sourceProvider: "gitlab",
        sourceRepo: "org/repo",
        targetOrg: "dest",
        targetProfileId: "enterprise",
      } as const;
      expect(() => start(request)).toThrow("cannot target GHES");
      expect(() => startBatch({ ...request, repos: [request.sourceRepo] })).toThrow(
        "cannot target GHES",
      );
    } finally {
      for (const key of ["GHES_TARGET_ID", "GHES_TARGET_API_URL"]) {
        if (env[key] === undefined) delete process.env[key];
        else process.env[key] = env[key];
      }
    }
  });
  test("a legacy GHES request cannot become restartable by confirming cloud-default columns", () => {
    const record: Migration = {
      ...migration("legacy", "reconciliation_required"),
      sourceProvider: "gitlab",
      requestOptions: JSON.stringify({ targetProfileId: "retired-enterprise" }),
    };
    insertMigration(record);
    expect(() => confirmRestart(record.id, "target/legacy")).toThrow("paused");
    expect(getMigration(record.id)?.state).toBe("reconciliation_required");
    expect(getEvents(record.id)).toEqual([]);
  });
  test("queues work beyond capacity and cancels it without launching", () => {
    for (let index = 0; index < MAX_CONCURRENT_MIGRATIONS; index += 1) {
      insertMigration(migration(`active-${index}`, "running"));
    }
    const queued = start({
      sourceProvider: "github",
      sourceApiUrl: "https://api.github.com",
      sourceRepo: "source/queued",
      targetOrg: "target",
      sourceToken: "source-token",
      targetToken: "target-token",
    });
    expect(queued.state).toBe("queued");
    expect(queued.requestOptions).not.toContain("source-token");
    expect(cancel(queued.id)).toBe(true);
    expect(getMigration(queued.id)?.state).toBe("cancelled");
    expect(cancel(queued.id)).toBe(false);
    expect(getEvents(queued.id).map((e) => e.payload)).toEqual([
      { message: "Queued migration cancelled before execution" },
    ]);
    expect(cancel("active-0")).toBe(true);
    expect(cancel("active-0")).toBe(false);
    expect(getEvents("active-0").map((e) => e.payload)).toEqual([
      { message: "Migration cancellation requested" },
    ]);
  });

  test("requires exact target confirmation before restart eligibility", () => {
    const record = migration("ambiguous", "reconciliation_required");
    insertMigration(record);
    expect(() => confirmRestart(record.id, "target/wrong")).toThrow(
      'Confirmation must exactly match "target/ambiguous"',
    );
    const confirmed = confirmRestart(record.id, "target/ambiguous");
    expect(confirmed.state).toBe("failed");
    expect(getEvents(record.id).at(-1)).toMatchObject({
      eventType: "step",
      payload: { message: expect.stringContaining("eligible for restart") },
    });
  });
});
