import { afterEach, expect, test } from "bun:test";
import type { GitHubClients } from "$lib/server/core/github";
import {
  __setGitLabToGhecDependenciesForTests,
  resumeGitLabToGhecMigration,
  runGitLabToGhecMigration,
} from "./gitlab-to-ghec";

const clients = {
  target: {},
  targetGraphql: {},
  getTargetToken: async () => "target-token",
} as unknown as GitHubClients;
let restore = () => {};
afterEach(() => restore());

test("runs a checkpointed GitLab export through the shared GHEC importer", async () => {
  const operations: string[] = [];
  restore = __setGitLabToGhecDependenciesForTests({
    requireTargetProfile: () => ({
      id: "ghec",
      platform: "ghec",
      displayName: "GHEC",
      apiUrl: "https://api.github.com",
      webUrl: "https://github.com",
      organizations: [],
    }),
    getSourceClient: () => ({
      apiUrl: "https://gitlab.example/api/v4",
      startProjectExport: async () => {
        operations.push("export-start");
      },
      getProjectExport: async () => ({ state: "finished" }),
      downloadProjectExport: async () => {},
    }),
    resolveTargetAuth: () => ({ token: "target-token" }),
    createClients: () => clients,
    doesOrgExist: async () => true,
    doesRepoExist: async () => false,
    updateCheckpoint: (_id, step) => operations.push(step),
    updateGitLabExportCheckpoint: (_id, step) => operations.push(step),
    downloadArchive: async () => "/tmp/gitlab-export.tar.gz",
    getOrgDatabaseId: async () => "1",
    uploadArchive: async () => "https://uploads.example/archive",
    createMigrationSource: async () => "SOURCE",
    executeArchiveToGhec: async ({ migration }) => {
      migration.githubMigrationId = "MIGRATION";
      migration.state = "succeeded";
      return migration;
    },
  });
  const result = await runGitLabToGhecMigration({
    id: "gitlab-1",
    sourceProvider: "gitlab",
    sourceRepo: "group/subgroup/project",
    targetOrg: "cloud",
    emit: () => {},
  });
  expect(result.state).toBe("succeeded");
  expect(operations).toEqual([
    "preflight",
    "source_export",
    "export-start",
    "source_export",
    "source_export_ready",
    "archive_upload",
  ]);
});

test("requires reconciliation when GitLab export creation is ambiguous", async () => {
  restore = __setGitLabToGhecDependenciesForTests({
    requireTargetProfile: () => ({
      id: "ghec",
      platform: "ghec",
      displayName: "GHEC",
      apiUrl: "https://api.github.com",
      webUrl: "https://github.com",
      organizations: [],
    }),
    getSourceClient: () => ({
      apiUrl: "https://gitlab.example/api/v4",
      startProjectExport: async () => {
        throw new Error("network lost");
      },
      getProjectExport: async () => ({ state: "none" }),
      downloadProjectExport: async () => {},
    }),
    resolveTargetAuth: () => ({ token: "target-token" }),
    createClients: () => clients,
    doesOrgExist: async () => true,
    doesRepoExist: async () => false,
    updateCheckpoint: () => {},
  });
  const result = await runGitLabToGhecMigration({
    id: "gitlab-2",
    sourceProvider: "gitlab",
    sourceRepo: "group/project",
    targetOrg: "cloud",
    emit: () => {},
  });
  expect(result.state).toBe("reconciliation_required");
});

test("resumes an acknowledged GitLab target migration without exporting again", async () => {
  let monitored = "";
  restore = __setGitLabToGhecDependenciesForTests({
    resolveTargetAuth: () => ({ token: "target-token" }),
    createClients: () => clients,
    monitorGhecMigration: async (_clients, migration, migrationId) => {
      monitored = migrationId;
      migration.state = "succeeded";
      return migration;
    },
  });
  const result = await resumeGitLabToGhecMigration(
    {
      id: "gitlab-recovery",
      githubMigrationId: "MIGRATION",
      sourceProvider: "gitlab",
      sourceApiUrl: "https://gitlab.example/api/v4",
      targetApiUrl: "https://api.github.com",
      targetProfileId: "ghec",
      sourceOrg: "group",
      sourceRepo: "project",
      targetOrg: "cloud",
      targetRepo: "project",
    } as never,
    () => {},
  );
  expect(monitored).toBe("MIGRATION");
  expect(result.state).toBe("succeeded");
});
