import { expect, test } from "bun:test";
import type { Migration } from "$lib/migrate/types";
import type { GitHubClients } from "$lib/server/core/github";
import { resumeNativeToGhecMigration } from "./native-to-ghec";

test("validates the source checkpoint before constructing the resume event", async () => {
  const messages: string[] = [];
  const clients = {
    target: {},
    targetGraphql: {},
  } as unknown as GitHubClients;
  const migration = {
    id: "native-resume",
    githubMigrationId: null,
    sourceApiUrl: "https://bitbucket.example/rest/api/1.0",
    targetApiUrl: "https://api.github.com",
    state: "running",
    requestOptions: JSON.stringify({ targetRepoVisibility: "private", skipReleases: true }),
    startedAt: "2026-08-18T00:00:00.000Z",
  } as Migration;
  const result = await resumeNativeToGhecMigration({
    emit: (event) => {
      if (event.eventType === "step") messages.push(event.payload.message);
    },
    migration,
    dependencies: {
      resolveTargetAuth: () => ({ token: "target-token" }),
      createClients: () => clients,
      abortMigration: async () => true,
      monitorGhecMigration: async () => {
        throw new Error("monitor should not run");
      },
    },
    getSourceExportId: () => "41",
    getSourceClient: () => ({ apiUrl: migration.sourceApiUrl }),
    resumeMessage: (exportId) => `Resuming Bitbucket export ${exportId}`,
    executeFromExport: async (request, sourceClient, targetClients) => {
      expect(request).toMatchObject({ targetRepoVisibility: "private", skipReleases: true });
      expect(sourceClient.apiUrl).toBe(migration.sourceApiUrl);
      expect(targetClients).toBe(clients);
      migration.state = "succeeded";
      return migration;
    },
  });

  expect(result.state).toBe("succeeded");
  expect(messages).toEqual(["Resuming Bitbucket export 41"]);
});
