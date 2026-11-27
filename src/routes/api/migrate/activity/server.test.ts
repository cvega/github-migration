import { beforeEach, describe, expect, test } from "bun:test";
import type { Migration } from "$lib/migrate/types";
import { initStore } from "$lib/server/core/db";
import { insertEvent } from "$lib/server/migrate/database/events";
import { insertMigration } from "$lib/server/migrate/database/migrations";
import { DOMAIN_STORES } from "$lib/server/schemas";
import { GET } from "./+server";

type GetArgs = Parameters<typeof GET>[0];

function request(query: string, locals: App.Locals): GetArgs {
  return { url: new URL(`http://localhost/api/migrate/activity${query}`), locals } as GetArgs;
}

const adminLocals: App.Locals = {
  authEnabled: true,
  user: {
    id: "fixture-admin",
    username: "admin",
    displayName: null,
    role: "admin",
    isActive: true,
    mustChangePassword: false,
  },
};

beforeEach(() => {
  initStore(":memory:", DOMAIN_STORES);
  const migration: Migration = {
    id: "activity-1",
    batchId: null,
    githubMigrationId: null,
    sourceProvider: "github",
    sourceApiUrl: "https://api.github.com",
    targetProfileId: "ghec",
    targetPlatform: "ghec",
    targetApiUrl: "https://api.github.com",
    sourceOrg: "acme",
    sourceRepo: "widgets",
    targetOrg: "acme-cloud",
    targetRepo: "widgets",
    state: "running",
    failureReason: null,
    migrationLogUrl: null,
    warningsCount: 0,
    sourceCounts: null,
    targetCounts: null,
    sourceSizeKb: null,
    startedAt: "2026-08-17T12:00:00.000Z",
    completedAt: null,
    elapsedSeconds: null,
    authMode: null,
    requestOptions: null,
  };
  insertMigration(migration);
  insertEvent({
    migrationId: migration.id,
    eventType: "failure",
    phase: null,
    payload: { error: "archive failed" },
    createdAt: "2026-08-17T12:00:01.000Z",
  });
  insertEvent({
    migrationId: migration.id,
    eventType: "restart",
    phase: null,
    payload: { message: "Restart requested" },
    createdAt: "2026-08-17T12:00:02.000Z",
  });
});

describe("GET migration activity", () => {
  test.each([adminLocals, { authEnabled: false }])(
    "returns newest activity in the public response shape with locals %j",
    async (locals) => {
      const response = await GET(request("?limit=1", locals));

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        items: [
          {
            kind: "restarted",
            repo: "acme/widgets",
            summary: "Restart requested",
          },
        ],
      });
    },
  );

  test("requires a session when authentication is enabled", () => {
    expect(() => GET(request("", { authEnabled: true }))).toThrow(
      expect.objectContaining({ status: 401 }),
    );
  });
});
