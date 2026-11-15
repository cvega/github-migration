import { afterEach, describe, expect, mock, test } from "bun:test";
import type { Migration, MigrationEvent } from "$lib/migrate/types";
import type { GitHubClients } from "$lib/server/core/github";
import {
  __setGitHubToGhecDependenciesForTests,
  resumeGitHubToGhecMigration,
  runGitHubToGhecMigration,
} from "./github-to-ghec";

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

function interruptedMigration(): Migration {
  return {
    id: "recovered-migration",
    batchId: null,
    githubMigrationId: "MIGRATION",
    sourceProvider: "github",
    sourceApiUrl: "https://source.example.com/api/v3",
    targetProfileId: "ghec",
    targetPlatform: "ghec",
    targetApiUrl: "https://api.github.com",
    sourceOrg: "acme",
    sourceRepo: "widget",
    targetOrg: "cloud",
    targetRepo: "widget",
    state: "running",
    failureReason: null,
    migrationLogUrl: null,
    warningsCount: 0,
    sourceCounts: null,
    targetCounts: null,
    sourceSizeKb: null,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    completedAt: null,
    elapsedSeconds: null,
    authMode: "env-pat",
    requestOptions: JSON.stringify({
      sourceRepo: "acme/widget",
      targetOrg: "cloud",
      archiveSource: true,
    }),
  };
}

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

  test("recovers an acknowledged import without repeating import or source archival", async () => {
    const migration = interruptedMigration();
    const signal = new AbortController().signal;
    const events: MigrationEvent[] = [];
    const archiveRepository = mock(async () => true);
    const executeArchiveToGhec = mock(async () => migration);
    restore = __setGitHubToGhecDependenciesForTests({
      resolveSourceAuth: () => ({ token: "source-token" }),
      resolveTargetAuth: () => ({ token: "target-token" }),
      createClients: (options) => {
        expect(options).toEqual({
          sourceApiUrl: migration.sourceApiUrl,
          sourceAuth: { token: "source-token" },
          targetApiUrl: migration.targetApiUrl,
          targetAuth: { token: "target-token" },
        });
        return clients;
      },
      monitorGhecMigration: async (restoredClients, record, migrationId, _emit, receivedSignal) => {
        expect(restoredClients).toBe(clients);
        expect(record).toBe(migration);
        expect(migrationId).toBe("MIGRATION");
        expect(receivedSignal).toBe(signal);
        return { ...record, state: "succeeded" };
      },
      executeArchiveToGhec,
      archiveRepository,
    });

    const result = await resumeGitHubToGhecMigration(
      migration,
      (event) => events.push(event),
      signal,
    );

    expect(result.state).toBe("succeeded");
    expect(executeArchiveToGhec).not.toHaveBeenCalled();
    expect(archiveRepository).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({
      eventType: "step",
      payload: {
        postTerminal: { operation: "source_archive", outcome: "not_attempted" },
        message: expect.stringContaining("manually"),
      },
    });
  });

  test("requires reconciliation when a recovered import can no longer be observed", async () => {
    restore = __setGitHubToGhecDependenciesForTests({
      resolveSourceAuth: () => ({ token: "source-token" }),
      resolveTargetAuth: () => ({ token: "target-token" }),
      createClients: () => clients,
      monitorGhecMigration: async () => {
        throw new Error("GitHub status unavailable");
      },
    });

    const result = await resumeGitHubToGhecMigration(interruptedMigration(), () => {});

    expect(result).toMatchObject({
      state: "reconciliation_required",
      failureReason: "GitHub status unavailable",
      githubMigrationId: "MIGRATION",
    });
    expect(result.completedAt).not.toBeNull();
    expect(result.elapsedSeconds).toBeGreaterThanOrEqual(60);
  });

  test.each([
    {
      outcome: "confirmed",
      state: "cancelled",
      reason: "Operator cancelled",
    },
    {
      outcome: "unconfirmed",
      state: "reconciliation_required",
      reason: "Remote migration could not be confirmed cancelled",
    },
    {
      outcome: "unavailable",
      state: "reconciliation_required",
      reason: "GitHub cancellation unavailable",
    },
  ])("handles $outcome cancellation of a recovered import", async ({ outcome, state, reason }) => {
    const controller = new AbortController();
    const abortMigration = mock(async () => {
      if (outcome === "unavailable") throw new Error("GitHub cancellation unavailable");
      return outcome === "confirmed";
    });
    restore = __setGitHubToGhecDependenciesForTests({
      resolveSourceAuth: () => ({ token: "source-token" }),
      resolveTargetAuth: () => ({ token: "target-token" }),
      createClients: () => clients,
      monitorGhecMigration: async () => {
        controller.abort(new Error("Operator cancelled"));
        throw controller.signal.reason;
      },
      abortMigration,
    });

    const result = await resumeGitHubToGhecMigration(
      interruptedMigration(),
      () => {},
      controller.signal,
    );

    expect(abortMigration).toHaveBeenCalledWith(clients.targetGraphql, "MIGRATION");
    expect(result).toMatchObject({ state, failureReason: reason });
    expect(result.completedAt).not.toBeNull();
  });
});
