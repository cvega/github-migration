import { expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Migration } from "$lib/migrate/types";
import { closeStore, initStore } from "$lib/server/core/db";
import { createTargetClients } from "$lib/server/core/github";
import { getEvents, insertEvent } from "../database/events";
import {
  getMigration,
  insertMigration,
  updateCheckpoint,
  updateGitLabExportCheckpoint,
  updateSourceExportCheckpoint,
} from "../database/migrations";
import { migrateStore } from "../database/schema";
import { __setArchiveToGhecDependenciesForTests } from "../executors/archive-to-ghec";
import { __setBitbucketToGhecDependenciesForTests } from "../executors/bitbucket-to-ghec";
import { __setGitLabToGhecDependenciesForTests } from "../executors/gitlab-to-ghec";
import { getRegisteredMigrationExecutor } from "../executors/registry";
import type { StartMigrationOptions } from "../github/migration-source";
import { serializeRequestOptions } from "../validate";
import { activeMigrationRuns } from "./active";
import { createMigrationRunFinisher } from "./finish";

test.each(["gitlab", "bitbucket-server"] as const)(
  "%s uses the approved options on safe resume and holds async target failures",
  async (sourceProvider) => {
    const gitlab = sourceProvider === "gitlab";
    const sourceApiUrl = gitlab
      ? "https://source.invalid/api/v4"
      : "https://source.invalid/rest/api/1.0";
    const plan = {
      sourceProvider,
      sourceApiUrl,
      sourceRepo: "org/repo",
      targetOrg: "dest",
      skipReleases: true,
      targetRepoVisibility: "private",
    } as const;
    const row: Migration = {
      id: "initial",
      batchId: null,
      githubMigrationId: null,
      sourceProvider,
      sourceApiUrl,
      sourceOrg: "org",
      sourceRepo: "repo",
      targetOrg: "dest",
      targetRepo: "repo",
      targetProfileId: "ghec",
      targetApiUrl: "https://api.github.com",
      targetPlatform: "ghec",
      state: "running",
      startedAt: new Date().toISOString(),
      completedAt: null,
      elapsedSeconds: null,
      sourceSizeKb: null,
      warningsCount: 0,
      sourceCounts: null,
      targetCounts: null,
      migrationLogUrl: null,
      failureReason: null,
      authMode: "env-pat",
      requestOptions: serializeRequestOptions(plan),
    };
    const marker = "fixture-credential-in-request";
    const error = Object.assign(new Error(marker), {
      request: { variables: { githubPat: marker } },
    });
    let exports = 0;
    const submissions: StartMigrationOptions[] = [];
    const common = {
      createClients: () => createTargetClients({ token: "fixture" }, row.targetApiUrl),
      resolveTargetAuth: () => ({ token: "fixture" }),
      doesOrgExist: async () => true,
      doesRepoExist: async () => false,
      downloadArchive: async () => join(tmpdir(), Bun.randomUUIDv7()),
      getOrgDatabaseId: async () => "1",
      uploadArchive: async () => "gei://fixture",
      createMigrationSource: async () => "source",
      monitorGhecMigration: async () => {
        await Promise.resolve();
        throw error;
      },
      abortMigration: async () => false,
    };
    const restore = gitlab
      ? __setGitLabToGhecDependenciesForTests({
          ...common,
          getSourceClient: () => ({
            apiUrl: sourceApiUrl,
            startProjectExport: async () => {
              exports++;
            },
            getProjectExport: async () => ({ state: "finished" }),
            downloadProjectExport: async () => {},
          }),
        })
      : __setBitbucketToGhecDependenciesForTests({
          ...common,
          getSourceClient: () => ({
            apiUrl: sourceApiUrl,
            startRepositoryExport: async () => {
              exports++;
              return "42";
            },
            getRepositoryExport: async () => ({
              id: "42",
              state: "COMPLETED",
              message: "",
              percentage: 100,
            }),
          }),
        });
    const restoreImporter = __setArchiveToGhecDependenciesForTests({
      getOrgId: async () => "org",
      startMigration: async (_graphql, options) => {
        submissions.push(options);
        await Promise.resolve();
        throw error;
      },
    });
    using log = spyOn(console, "error").mockImplementation(() => {});
    using warn = spyOn(console, "warn").mockImplementation(() => {});
    initStore(":memory:", [migrateStore]);
    try {
      const executor = getRegisteredMigrationExecutor({ sourceProvider, targetPlatform: "ghec" });
      insertMigration(row);
      const resumed = { ...row, id: "resumed" };
      insertMigration(resumed);
      if (gitlab) updateGitLabExportCheckpoint(resumed.id, "source_export_ready");
      else updateSourceExportCheckpoint(resumed.id, "source_export_ready", "42");
      const results = [
        await executor.run({ ...plan, id: row.id, emit: insertEvent }),
        await executor.resume(resumed, insertEvent),
      ];
      for (const result of results) {
        expect(result.state).toBe("reconciliation_required");
        const claim = activeMigrationRuns.claim(result.id)!;
        createMigrationRunFinisher(() => {}).settleResult(result.id, claim.token, result);
        expect(getMigration(result.id)?.state).toBe("reconciliation_required");
        expect(JSON.stringify([getEvents(result.id), getMigration(result.id)])).not.toContain(
          marker,
        );
      }
      expect(submissions).toHaveLength(2); // one per independent admitted job
      expect(submissions[0]).toMatchObject({ targetRepoVisibility: "private", skipReleases: true });
      expect(submissions[1]).toEqual(submissions[0]);
      // Direct entry from an ambiguous checkpoint cannot bypass startup classification.
      expect((await executor.resume(resumed, insertEvent)).state).toBe("reconciliation_required");
      updateCheckpoint(resumed.id, "monitoring", { githubMigrationId: "accepted-id" });
      for (const signal of [undefined, AbortSignal.abort()]) {
        const result = await executor.resume(getMigration(resumed.id)!, insertEvent, signal);
        expect(result).toMatchObject({
          state: "reconciliation_required",
          githubMigrationId: "accepted-id",
        });
        expect(result.failureReason).not.toContain(marker);
      }
      expect(submissions).toHaveLength(2);
      expect(exports).toBe(1);
      expect(JSON.stringify([log.mock.calls, warn.mock.calls])).not.toContain(marker);
    } finally {
      restoreImporter();
      restore();
      closeStore();
    }
  },
);
