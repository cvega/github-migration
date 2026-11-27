import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { CreateMigrationRequest, Migration, MigrationState } from "$lib/migrate/types";
import { closeStore, initStore } from "$lib/server/core/db";
import { insertEvent } from "../database/events";
import { insertGhesImportJob } from "../database/import-jobs";
import { getMigration, insertMigration, updateMigrationState } from "../database/migrations";
import { migrateStore } from "../database/schema";
import { getRegisteredMigrationExecutor } from "../executors/registry";
import { cancel, confirmRestart, restart, start } from "../manager";
import { activeMigrationRuns } from "./active";
import {
  drainMigrationQueue,
  getCapacityUsage,
  MAX_CONCURRENT_MIGRATIONS,
  shouldQueueMigration,
} from "./queue";

beforeEach(() => initStore(":memory:", [migrateStore]));
afterEach(closeStore);

function request(sourceRepo: string): CreateMigrationRequest {
  return { sourceRepo, targetOrg: "acme-cloud", sourceToken: "secret" };
}

function migration(id: string, state: MigrationState): Migration {
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
    state,
    failureReason: null,
    migrationLogUrl: null,
    warningsCount: 0,
    sourceCounts: null,
    targetCounts: null,
    sourceSizeKb: null,
    startedAt: `2026-08-18T12:00:${id.padStart(2, "0")}.000Z`,
    completedAt: null,
    elapsedSeconds: null,
    authMode: null,
    requestOptions: null,
  };
}

const enterprise = (id: string, batchId: string | null, state: MigrationState): Migration => ({
  ...migration(id, state),
  batchId,
  sourceProvider: "bitbucket-server",
  targetPlatform: "ghes",
  targetProfileId: "enterprise",
  targetApiUrl: "https://enterprise.example/api/v3",
});

describe("migration queue", () => {
  test("holds siblings after a failure without blocking unrelated work or losing a queued restart", () => {
    const blocker = enterprise("01", "held", "failed");
    const sibling = { ...enterprise("02", "held", "queued"), startedAt: "2000-01-01T00:00:00Z" };
    insertMigration(blocker);
    expect(shouldQueueMigration(sibling)).toBe(true);
    insertMigration(sibling);
    insertMigration(enterprise("06", "held", "queued"));
    insertMigration(enterprise("03", "other", "queued"));
    insertMigration({ ...migration("04", "queued"), batchId: "held" });
    const launched: string[] = [];
    const drain = () =>
      drainMigrationQueue((id) => {
        launched.push(id);
        return true;
      });
    for (const id of ["02", "03", "04", "06"])
      activeMigrationRuns.enqueue(id, request(`acme/${id}`));
    try {
      drain();
      expect(launched).toEqual(["03", "04"]);
      expect(cancel("06")).toBe(true);
      expect(getMigration("06")?.state).toBe("cancelled");
      expect(getMigration("02")?.state).toBe("queued");
      expect(restart("01", { sourceToken: "test", targetToken: "test" }).state).toBe("queued");
      updateMigrationState("03", "succeeded");
      expect(shouldQueueMigration(sibling)).toBe(true);
      const secondBlocker = enterprise("07", "held", "failed");
      insertMigration(secondBlocker);
      drain();
      expect(getMigration("01")?.state).toBe("queued");
      expect(shouldQueueMigration(secondBlocker)).toBe(false);
      // Model the second blocker's successful retry without calling an executor.
      updateMigrationState("07", "pending");
      updateMigrationState("07", "succeeded");
      drain();
      expect(launched).toEqual(["03", "04", "01"]);
      // The appliance becomes available to another batch after a failed retry.
      insertMigration(enterprise("05", "other", "queued"));
      activeMigrationRuns.enqueue("05", request("acme/05"));
      updateMigrationState("01", "failed");
      drain();
      expect(launched.at(-1)).toBe("05");
      expect(getMigration("02")?.state).toBe("queued");
      expect(restart("01", { sourceToken: "test", targetToken: "test" }).state).toBe("queued");
      updateMigrationState("05", "succeeded");
      drain();
      expect(launched.at(-1)).toBe("01");
      updateMigrationState("01", "succeeded");
      drain();
      expect(launched).toEqual(["03", "04", "01", "05", "01", "02"]);
    } finally {
      for (const id of ["01", "02", "03", "04", "05", "06"]) activeMigrationRuns.dropQueued(id);
    }
  });

  test.each([
    "preparing",
    "mapping",
    "importing",
    "auditing",
    "unlocking",
    "reconciliation_required",
  ] as const)(
    "blocks GHES starts, restarts and other batches until confirmation at %s",
    async (phase) => {
      const blocker = enterprise("01", "held", "reconciliation_required");
      insertMigration(blocker);
      insertGhesImportJob({
        id: "job",
        migrationId: blocker.id,
        phase,
        exporterJobId: "export",
        archivePath: null,
        archiveSha256: null,
        ghesImportId:
          phase === "preparing" || phase === "reconciliation_required" ? null : "saved-guid",
        sourceWasArchived: true,
        failureReason: null,
        createdAt: blocker.startedAt,
        updatedAt: blocker.startedAt,
      });
      if (phase === "reconciliation_required")
        insertEvent({
          migrationId: blocker.id,
          eventType: "step",
          phase: null,
          payload: { message: "Preparing", executorPhase: "preparing" },
          createdAt: blocker.startedAt,
        });
      insertMigration(enterprise("02", "other", "queued"));
      activeMigrationRuns.enqueue("02", request("acme/02"));
      insertMigration(enterprise("03", null, "failed"));
      const env = { ...process.env };
      process.env.GHES_TARGET_ID = "enterprise";
      process.env.GHES_TARGET_API_URL = blocker.targetApiUrl;
      const executor = getRegisteredMigrationExecutor(blocker);
      using run = spyOn(executor, "run").mockImplementation(async ({ id }) => ({
        ...getMigration(id!)!,
        state: "succeeded",
      }));
      try {
        const started = start({
          ...request("acme/new"),
          sourceApiUrl: "https://bb.example",
          targetToken: "fixture",
          sourceProvider: "bitbucket-server",
          targetProfileId: "enterprise",
        });
        expect(started.state).toBe("queued");
        expect(restart("03", { sourceToken: "fixture", targetToken: "fixture" }).state).toBe(
          "queued",
        );
        insertMigration(migration("04", "queued"));
        activeMigrationRuns.enqueue("04", request("acme/04"));
        const launched: string[] = [];
        drainMigrationQueue((id) => {
          launched.push(id);
          return true;
        });
        expect(launched).toEqual(["04"]);
        expect(() => restart("01", {})).toThrow("reconciliation_required");
        confirmRestart("01", "acme-cloud/01");
        await Bun.sleep(0);
        expect(run).toHaveBeenCalledTimes(3);
        for (const id of ["02", "03", started.id])
          expect(getMigration(id)?.state).toBe("succeeded");
      } finally {
        for (const key of ["GHES_TARGET_ID", "GHES_TARGET_API_URL"]) {
          if (env[key] === undefined) delete process.env[key];
          else process.env[key] = env[key];
        }
      }
    },
  );

  test("serializes GHES admissions and drains without blocking cloud work", () => {
    for (const id of ["01", "02", "03"]) {
      insertMigration({
        ...migration(id, "queued"),
        sourceProvider: "bitbucket-server",
        targetPlatform: "ghes",
        targetProfileId: "enterprise",
        targetApiUrl: "https://enterprise.example/api/v3",
      });
      activeMigrationRuns.enqueue(id, request(`acme/${id}`));
    }
    insertMigration(migration("04", "queued"));
    activeMigrationRuns.enqueue("04", request("acme/04"));
    const launched: string[] = [];
    const launch = (id: string) => {
      launched.push(id);
      return true;
    };
    const enterprise = { ...migration("new", "pending"), targetPlatform: "ghes" } as const;
    expect(shouldQueueMigration(enterprise)).toBe(false);
    drainMigrationQueue(launch);
    expect(launched).toEqual(["01", "04"]);
    expect(shouldQueueMigration(enterprise)).toBe(true);
    expect(shouldQueueMigration(migration("cloud", "pending"))).toBe(false);
    updateMigrationState("01", "succeeded");
    drainMigrationQueue(launch);
    expect(launched).toEqual(["01", "04", "02"]);
    expect(getMigration("03")?.state).toBe("queued");
    activeMigrationRuns.dropQueued("03");
  });
  test("stops cleanly when no queued migration exists", () => {
    let launches = 0;
    drainMigrationQueue(() => {
      launches += 1;
      return true;
    });
    expect(launches).toBe(0);
  });

  test("fails a claimed migration when its secret request is missing", () => {
    using consoleError = spyOn(console, "error");
    consoleError.mockImplementation(() => {});
    insertMigration(migration("01", "queued"));
    drainMigrationQueue(() => true);
    expect(getMigration("01")).toMatchObject({
      state: "failed",
      failureReason: "Queued migration request lost (internal error)",
    });
  });

  test("keeps a slot for a terminal migration whose promise is settling", () => {
    for (let index = 0; index < MAX_CONCURRENT_MIGRATIONS - 1; index += 1) {
      insertMigration(migration(String(index).padStart(2, "0"), "running"));
    }
    insertMigration(migration("settling", "pending"));
    const registration = activeMigrationRuns.claim("settling");
    if (!registration) throw new Error("settling run was not claimed");
    activeMigrationRuns.attach("settling", registration.token, Promise.resolve());
    updateMigrationState("settling", "succeeded");
    insertMigration(migration("queued", "queued"));
    activeMigrationRuns.enqueue("queued", request("acme/queued"));

    try {
      expect(getCapacityUsage()).toBe(MAX_CONCURRENT_MIGRATIONS);
      drainMigrationQueue(() => true);
      expect(getMigration("queued")?.state).toBe("queued");
    } finally {
      activeMigrationRuns.finish("settling", registration.token);
      activeMigrationRuns.dropQueued("queued");
    }
  });

  test("promotes queued migrations in FIFO order up to available capacity", () => {
    for (let index = 0; index < MAX_CONCURRENT_MIGRATIONS - 2; index += 1) {
      insertMigration(migration(String(index).padStart(2, "0"), "running"));
    }
    for (const id of ["10", "11", "12"]) {
      insertMigration(migration(id, "queued"));
      activeMigrationRuns.enqueue(id, request(`acme/${id}`));
    }
    const launched: string[] = [];
    drainMigrationQueue((id) => {
      launched.push(id);
      return true;
    });

    expect(launched).toEqual(["10", "11"]);
    expect(getMigration("10")?.state).toBe("pending");
    expect(getMigration("11")?.state).toBe("pending");
    expect(getMigration("12")?.state).toBe("queued");
    activeMigrationRuns.dropQueued("12");
  });
});
