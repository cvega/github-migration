import { afterEach, describe, expect, test } from "bun:test";
import type { GitHubClients } from "$lib/server/core/github";
import { __setGitHubToGhecDependenciesForTests, runGitHubToGhecMigration } from "./github-to-ghec";

const clients = {
  source: {},
  sourceGraphql: {},
  target: {},
  targetGraphql: {},
  getSourceToken: async () => "source-token",
  getTargetToken: async () => "target-token",
} as unknown as GitHubClients;

let restore = () => {};
afterEach(() => restore());

describe("GitHub-to-GHEC executor", () => {
  test("composes preflight, archive resolution, GHEC import, and source archival", async () => {
    const operations: string[] = [];
    restore = __setGitHubToGhecDependenciesForTests({
      requireTargetProfile: () => ({
        id: "ghec",
        platform: "ghec",
        displayName: "GHEC",
        apiUrl: "https://api.github.com",
        webUrl: "https://github.com",
        organizations: [],
      }),
      resolveSourceAuth: () => ({ token: "source-token" }),
      resolveTargetAuth: () => ({ token: "target-token" }),
      createClients: () => clients,
      doesOrgExist: async () => true,
      doesRepoExist: async () => false,
      getRepoCounts: async () => ({
        commits: 1,
        branches: 1,
        tags: 0,
        issues: 0,
        pullRequests: 0,
        releases: 0,
      }),
      getRepoSize: async () => 42,
      updateMigrationSourceSize: (_id, size) => operations.push(`size:${size}`),
      updateCheckpoint: (_id, step) => operations.push(step),
      resolveArchives: async () => ({
        gitArchiveUrl: "https://uploads.example/git",
        metadataArchiveUrl: "https://uploads.example/metadata",
      }),
      executeArchiveToGhec: async ({ migration, markRemoteStartMayHaveSucceeded }) => {
        markRemoteStartMayHaveSucceeded?.(true);
        migration.githubMigrationId = "MIGRATION";
        markRemoteStartMayHaveSucceeded?.(false);
        migration.state = "succeeded";
        return migration;
      },
      getRepositoryNodeId: async () => "REPO",
      archiveRepository: async () => {
        operations.push("source-archived");
        return true;
      },
    });

    const events: string[] = [];
    const result = await runGitHubToGhecMigration({
      id: "migration-1",
      sourceProvider: "github",
      sourceApiUrl: "https://api.github.com",
      sourceRepo: "acme/widget",
      targetOrg: "cloud",
      archiveSource: true,
      emit: (event) =>
        events.push(event.eventType === "step" ? event.payload.message : event.eventType),
    });

    expect(result).toMatchObject({ state: "succeeded", sourceSizeKb: 42 });
    expect(operations).toEqual([
      "preflight",
      "size:42",
      "archiving",
      "post_migration",
      "source-archived",
    ]);
    expect(events.at(-1)).toContain("archived");
  });

  test("requires reconciliation when the remote start outcome is unknown", async () => {
    restore = __setGitHubToGhecDependenciesForTests({
      requireTargetProfile: () => ({
        id: "ghec",
        platform: "ghec",
        displayName: "GHEC",
        apiUrl: "https://api.github.com",
        webUrl: "https://github.com",
        organizations: [],
      }),
      resolveSourceAuth: () => ({ token: "source-token" }),
      resolveTargetAuth: () => ({ token: "target-token" }),
      createClients: () => clients,
      doesOrgExist: async () => true,
      doesRepoExist: async () => false,
      getRepoCounts: async () => {
        throw new Error("optional");
      },
      getRepoSize: async () => null,
      updateCheckpoint: () => {},
      resolveArchives: async () => ({ gitArchiveUrl: "", metadataArchiveUrl: "" }),
      executeArchiveToGhec: async ({ markRemoteStartMayHaveSucceeded }) => {
        markRemoteStartMayHaveSucceeded?.(true);
        throw new Error("connection lost after mutation");
      },
    });
    const result = await runGitHubToGhecMigration({
      id: "migration-2",
      sourceRepo: "acme/widget",
      targetOrg: "cloud",
      emit: () => {},
    });
    expect(result).toMatchObject({
      state: "reconciliation_required",
      failureReason: "connection lost after mutation",
    });
  });
});
