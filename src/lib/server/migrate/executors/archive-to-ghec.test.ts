import { afterEach, describe, expect, test } from "bun:test";
import type { Counts, Migration } from "$lib/migrate/types";
import type { GitHubClients } from "$lib/server/core/github";
import { __setArchiveToGhecDependenciesForTests, executeArchiveToGhec } from "./archive-to-ghec";

const counts: Counts = {
  commits: 4,
  branches: 2,
  tags: 1,
  issues: 3,
  pullRequests: 2,
  releases: 1,
};
const clients = {
  target: {},
  targetGraphql: {},
} as unknown as GitHubClients;
const migration = {
  id: "migration-1",
  sourceOrg: "acme",
  sourceRepo: "widget",
  targetOrg: "cloud",
  targetRepo: "widget",
  sourceCounts: counts,
  startedAt: new Date().toISOString(),
} as Migration;

let restore = () => {};
afterEach(() => restore());

describe("archive-to-GHEC executor", () => {
  test("checkpoints the ambiguous write before start and the ID immediately after", async () => {
    const operations: string[] = [];
    const unknown: boolean[] = [];
    restore = __setArchiveToGhecDependenciesForTests({
      getOrgId: async () => "ORG",
      createMigrationSource: async () => "SOURCE",
      updateCheckpoint: (_id, step, extras) => {
        operations.push(`${step}:${extras?.githubMigrationId ?? ""}`);
      },
      startMigration: async (_gql, options) => {
        operations.push(`start:${options.migrationSourceId}`);
        return "MIGRATION";
      },
      monitor: async () => ({ phase: "SUCCEEDED", finalCounts: counts }),
    });
    const result = await executeArchiveToGhec({
      clients,
      migration: { ...migration },
      request: {},
      sourceRepoUrl: "https://github.example/acme/widget",
      sourceToken: "source-token",
      targetToken: "target-token",
      gitArchiveUrl: "https://uploads.example/git",
      metadataArchiveUrl: "https://uploads.example/metadata",
      emit: () => {},
      markRemoteStartMayHaveSucceeded: (value) => unknown.push(value),
    });

    expect(operations).toEqual(["ghec_starting:", "start:SOURCE", "monitoring:MIGRATION"]);
    expect(unknown).toEqual([true, false]);
    expect(result).toMatchObject({
      state: "succeeded",
      githubMigrationId: "MIGRATION",
      targetCounts: counts,
    });
  });

  test("leaves the ambiguous-write marker set when start throws", async () => {
    const unknown: boolean[] = [];
    restore = __setArchiveToGhecDependenciesForTests({
      getOrgId: async () => "ORG",
      createMigrationSource: async () => "SOURCE",
      updateCheckpoint: () => {},
      startMigration: async () => {
        throw new Error("connection lost");
      },
    });
    await expect(
      executeArchiveToGhec({
        clients,
        migration: { ...migration },
        request: {},
        sourceRepoUrl: "https://github.example/acme/widget",
        sourceToken: "source-token",
        targetToken: "target-token",
        gitArchiveUrl: "",
        metadataArchiveUrl: "",
        emit: () => {},
        markRemoteStartMayHaveSucceeded: (value) => unknown.push(value),
      }),
    ).rejects.toThrow("connection lost");
    expect(unknown).toEqual([true]);
  });
});
