import { afterEach, expect, test } from "bun:test";
import type { GitHubClients } from "$lib/server/core/github";
import {
  __setBitbucketToGhecDependenciesForTests,
  resumeBitbucketToGhecMigration,
  runBitbucketToGhecMigration,
} from "./bitbucket-to-ghec";

const clients = {
  target: {},
  targetGraphql: {},
  getTargetToken: async () => "target-token",
} as unknown as GitHubClients;
let restore = () => {};
afterEach(() => restore());

test("persists the Bitbucket export ID before polling and importing", async () => {
  const operations: string[] = [];
  restore = __setBitbucketToGhecDependenciesForTests({
    requireTargetProfile: () => ({
      id: "ghec",
      platform: "ghec",
      displayName: "GHEC",
      apiUrl: "https://api.github.com",
      webUrl: "https://github.com",
      organizations: [],
    }),
    getSourceClient: () => ({
      apiUrl: "https://bitbucket.example/rest/api/1.0",
      startRepositoryExport: async () => {
        operations.push("export-start");
        return "41";
      },
      getRepositoryExport: async () => ({
        id: "41",
        state: "COMPLETED",
        message: "",
        percentage: 100,
      }),
    }),
    resolveTargetAuth: () => ({ token: "target-token" }),
    createClients: () => clients,
    doesOrgExist: async () => true,
    doesRepoExist: async () => false,
    updateCheckpoint: (_id, step) => operations.push(step),
    updateSourceExportCheckpoint: (_id, step, exportId) => operations.push(`${step}:${exportId}`),
    downloadArchive: async () => "/tmp/bitbucket-export.tar",
    getOrgDatabaseId: async () => "1",
    uploadArchive: async () => "https://uploads.example/archive",
    createMigrationSource: async () => "SOURCE",
    executeArchiveToGhec: async ({ migration }) => {
      migration.githubMigrationId = "MIGRATION";
      migration.state = "succeeded";
      return migration;
    },
  });
  const result = await runBitbucketToGhecMigration({
    id: "bitbucket-1",
    sourceProvider: "bitbucket-server",
    sourceRepo: "PROJ/repo",
    targetOrg: "cloud",
    emit: () => {},
  });
  expect(result.state).toBe("succeeded");
  expect(operations).toEqual([
    "preflight",
    "source_export",
    "export-start",
    "source_export:41",
    "source_export_ready:41",
    "archive_upload",
  ]);
});

test("requires reconciliation when Bitbucket export creation is ambiguous", async () => {
  restore = __setBitbucketToGhecDependenciesForTests({
    requireTargetProfile: () => ({
      id: "ghec",
      platform: "ghec",
      displayName: "GHEC",
      apiUrl: "https://api.github.com",
      webUrl: "https://github.com",
      organizations: [],
    }),
    getSourceClient: () => ({
      apiUrl: "https://bitbucket.example/rest/api/1.0",
      startRepositoryExport: async () => {
        throw new Error("network lost");
      },
      getRepositoryExport: async () => ({
        id: "1",
        state: "RUNNING",
        message: "",
        percentage: 0,
      }),
    }),
    resolveTargetAuth: () => ({ token: "target-token" }),
    createClients: () => clients,
    doesOrgExist: async () => true,
    doesRepoExist: async () => false,
    updateCheckpoint: () => {},
  });
  const result = await runBitbucketToGhecMigration({
    id: "bitbucket-2",
    sourceProvider: "bitbucket-server",
    sourceRepo: "PROJ/repo",
    targetOrg: "cloud",
    emit: () => {},
  });
  expect(result.state).toBe("reconciliation_required");
});

test("resumes an acknowledged Bitbucket target migration without exporting again", async () => {
  let monitored = "";
  restore = __setBitbucketToGhecDependenciesForTests({
    resolveTargetAuth: () => ({ token: "target-token" }),
    createClients: () => clients,
    monitorGhecMigration: async (_clients, migration, migrationId) => {
      monitored = migrationId;
      migration.state = "succeeded";
      return migration;
    },
  });
  const result = await resumeBitbucketToGhecMigration(
    {
      id: "bitbucket-recovery",
      githubMigrationId: "MIGRATION",
      sourceProvider: "bitbucket-server",
      sourceApiUrl: "https://bitbucket.example/rest/api/1.0",
      targetApiUrl: "https://api.github.com",
      targetProfileId: "ghec",
      sourceOrg: "PROJ",
      sourceRepo: "repo",
      targetOrg: "cloud",
      targetRepo: "repo",
    } as never,
    () => {},
  );
  expect(monitored).toBe("MIGRATION");
  expect(result.state).toBe("succeeded");
});
