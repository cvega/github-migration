import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Migration } from "$lib/migrate/types";
import { closeStore, initStore } from "$lib/server/core/db";
import { insertMigration } from "../database/migrations";
import { migrateStore } from "../database/schema";
import {
  __setBitbucketToGhesDependenciesForTests,
  runBitbucketToGhesMigration,
} from "./bitbucket-to-ghes";

let restore = () => {};

beforeEach(() => initStore(":memory:", [migrateStore]));
afterEach(() => {
  restore();
  restore = () => {};
  closeStore();
});

function migration(): Migration {
  return {
    id: "bitbucket-ghes",
    batchId: null,
    githubMigrationId: null,
    sourceProvider: "bitbucket-server",
    sourceApiUrl: "https://bitbucket.example/rest/api/1.0",
    targetProfileId: "ghes",
    targetPlatform: "ghes",
    targetApiUrl: "https://ghes.example/api/v3",
    sourceOrg: "PLATFORM",
    sourceRepo: "service",
    targetOrg: "target",
    targetRepo: "service",
    state: "running",
    failureReason: null,
    migrationLogUrl: null,
    warningsCount: 0,
    sourceCounts: null,
    targetCounts: null,
    sourceSizeKb: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    elapsedSeconds: null,
    authMode: "env-pat",
    requestOptions: "{}",
  };
}

test("fails before export when the configured Bitbucket source changed", async () => {
  const record = migration();
  insertMigration(record);
  let workerCreated = false;
  restore = __setBitbucketToGhesDependenciesForTests({
    getConfig: () =>
      ({
        profile: {
          apiUrl: record.targetApiUrl,
          webUrl: "https://ghes.example",
        },
      }) as never,
    getSourceConfig: () =>
      ({
        apiUrl: record.sourceApiUrl,
        authAvailable: false,
      }) as never,
    createWorker: () => {
      workerCreated = true;
      throw new Error("worker should not be created");
    },
  });

  const result = await runBitbucketToGhesMigration({
    id: record.id,
    sourceProvider: "bitbucket-server",
    emit: () => {},
  });

  expect(result.state).toBe("failed");
  expect(result.failureReason).toContain("Configured Bitbucket source changed");
  expect(workerCreated).toBe(false);
});
