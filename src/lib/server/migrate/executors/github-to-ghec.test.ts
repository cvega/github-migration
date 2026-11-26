import { afterEach, describe, expect, mock, test } from "bun:test";
import type { Migration, MigrationEvent } from "$lib/migrate/types";
import type { GitHubClients } from "$lib/server/core/github";
import { __setArchiveTransportDependenciesForTests } from "../github/exports";
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
  test.each([true, false])("reports source archival only when confirmed (%p)", async (archived) => {
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
        return archived;
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
    expect(events.at(-1)).toContain(archived ? "archived" : "could not be confirmed");
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
        throw new Error("private upstream diagnostic");
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
      failureReason: "GHEC import outcome is unknown; check the target before restarting",
    });
  });

  test.each([
    { outcome: "git rejected", state: "failed", metadata: false },
    { outcome: "git unconfirmed", state: "reconciliation_required", metadata: false },
    { outcome: "metadata rejected", state: "reconciliation_required", metadata: true },
    { outcome: "metadata unconfirmed", state: "reconciliation_required", metadata: true },
    { outcome: "cancel after git", state: "reconciliation_required", metadata: false },
  ])(
    "classifies a GHES export pair by the writes that could have occurred: $outcome",
    async ({ outcome, state, metadata }) => {
      const controller = new AbortController();
      const operations: string[] = [];
      const rejection = Object.assign(new Error("private upstream diagnostic"), { status: 422 });
      const restoreExports = __setArchiveTransportDependenciesForTests({
        startGitArchiveExport: async () => {
          operations.push("git");
          if (outcome === "git rejected") throw rejection;
          if (outcome === "git unconfirmed") throw new Error("private upstream diagnostic");
          if (outcome === "cancel after git") controller.abort();
          return 1;
        },
        startMetadataArchiveExport: async () => {
          operations.push("metadata");
          if (outcome === "metadata rejected") throw rejection;
          throw new Error("private upstream diagnostic");
        },
      });
      restore = __setGitHubToGhecDependenciesForTests({
        createClients: () => clients,
        resolveSourceAuth: () => ({ token: "fixture" }),
        resolveTargetAuth: () => ({ token: "fixture" }),
        checkGhesVersion: async () => "3.15.0",
        doesOrgExist: async () => true,
        doesRepoExist: async () => false,
        getRepoCounts: async () => {
          throw new Error("unavailable");
        },
        getRepoSize: async () => null,
        updateCheckpoint: (_id, step) => operations.push(step),
      });
      try {
        const result = await runGitHubToGhecMigration({
          sourceApiUrl: "https://ghes.example/api/v3",
          sourceRepo: "acme/widget",
          targetOrg: "cloud",
          signal: controller.signal,
          emit: () => {},
        });
        expect(result).toMatchObject({
          state,
          githubMigrationId: null,
          failureReason:
            state === "failed"
              ? "Could not prepare source archives; check the source export and archive configuration"
              : outcome === "git unconfirmed"
                ? "Source export outcome is unknown; check the source before restarting"
                : "Git archive export 1 was accepted; check the source exports before restarting",
        });
        expect(operations).toEqual([
          "preflight",
          "source_export",
          "git",
          ...(metadata ? ["metadata"] : []),
        ]);
      } finally {
        restoreExports();
      }
    },
  );

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
      failureReason: "GHEC import outcome is unknown; check the target before restarting",
      githubMigrationId: "MIGRATION",
    });
    expect(result.completedAt).not.toBeNull();
    expect(result.elapsedSeconds).toBeGreaterThanOrEqual(60);
  });

  test.each([
    {
      outcome: "confirmed",
      state: "cancelled",
      reason: "Migration cancelled",
    },
    {
      outcome: "unconfirmed",
      state: "reconciliation_required",
      reason: "Remote migration could not be confirmed cancelled",
    },
    {
      outcome: "unavailable",
      state: "reconciliation_required",
      reason: "Remote migration could not be confirmed cancelled",
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
