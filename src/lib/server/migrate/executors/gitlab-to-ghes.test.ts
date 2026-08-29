import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Migration } from "$lib/migrate/types";
import { closeStore, initStore } from "$lib/server/core/db";
import { insertMigration } from "../database/migrations";
import { migrateStore } from "../database/schema";
import { __setGitLabToGhesDependenciesForTests, runGitLabToGhesMigration } from "./gitlab-to-ghes";

let restore = () => {};

beforeEach(() => initStore(":memory:", [migrateStore]));
afterEach(() => {
  restore();
  restore = () => {};
  closeStore();
});

function migration(): Migration {
  return {
    id: "gitlab-ghes",
    batchId: null,
    githubMigrationId: null,
    sourceProvider: "gitlab",
    sourceApiUrl: "https://gitlab.example/api/v4",
    targetProfileId: "ghes",
    targetPlatform: "ghes",
    targetApiUrl: "https://ghes.example/api/v3",
    sourceOrg: "platform",
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

test("fails before export when the configured GitLab source changed", async () => {
  const record = migration();
  insertMigration(record);
  let workerCreated = false;
  restore = __setGitLabToGhesDependenciesForTests({
    getConfig: () =>
      ({
        profile: {
          apiUrl: record.targetApiUrl,
          webUrl: "https://ghes.example",
        },
      }) as never,
    getSourceClient: () =>
      ({
        apiUrl: "https://different.example/api/v4",
        isProjectArchived: async () => false,
        unarchiveProject: async () => {},
      }) as never,
    createWorker: () => {
      workerCreated = true;
      throw new Error("worker should not be created");
    },
  });

  const result = await runGitLabToGhesMigration({
    id: record.id,
    sourceProvider: "gitlab",
    emit: () => {},
  });

  expect(result.state).toBe("failed");
  expect(result.failureReason).toContain("Configured GitLab source URL changed");
  expect(workerCreated).toBe(false);
});
