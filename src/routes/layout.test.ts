import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AuthUser } from "$lib/auth-user";
import type { Migration } from "$lib/migrate/types";
import { initStore } from "$lib/server/core/db";
import { insertEvent } from "$lib/server/migrate/database/events";
import { insertMigration } from "$lib/server/migrate/database/migrations";
import { DOMAIN_STORES } from "$lib/server/schemas";
import { load } from "./+layout.server";

const ENV_KEYS = [
  "GH_SOURCE_API_URL",
  "GH_SOURCE_ORG",
  "GH_TARGET_ORG",
  "GH_SOURCE_APP_ID",
  "GH_SOURCE_APP_PRIVATE_KEY",
  "GH_SOURCE_APP_INSTALLATION_ID",
  "GHES_TARGET_NAME",
  "GHES_TARGET_API_URL",
  "GHES_TARGET_ORG",
  "GITLAB_SOURCE_NAMESPACE",
  "BITBUCKET_SERVER_PROJECT_KEYS",
] as const;

const SENTINELS = [
  "internal-source.example.com",
  "internal-target.example.com",
  "source-org-sentinel",
  "target-org-sentinel",
  "internal-app-id",
  "gitlab-namespace-sentinel",
  "BITBUCKET-SENTINEL",
  "internal-repo-sentinel",
  "failure-summary-sentinel",
];

let savedEnv: Record<string, string | undefined>;

const AUTHENTICATED_USER: AuthUser = {
  id: "user-1",
  username: "operator",
  displayName: "Migration Operator",
  role: "operator",
  isActive: true,
  mustChangePassword: false,
};

function event(authEnabled: boolean, user?: AuthUser) {
  return {
    locals: { authEnabled, user },
  };
}

async function loadLayout(authEnabled: boolean, user?: AuthUser) {
  const data = await load(event(authEnabled, user) as Parameters<typeof load>[0]);
  if (!data) throw new Error("Root layout did not return data");
  return data;
}

function expectNoSentinels(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const sentinel of SENTINELS) expect(serialized).not.toContain(sentinel);
}

function sentinelMigration(): Migration {
  return {
    id: "layout-sentinel",
    batchId: null,
    githubMigrationId: null,
    sourceProvider: "github",
    sourceApiUrl: "https://internal-source.example.com/api/v3",
    targetProfileId: "ghec",
    targetPlatform: "ghec",
    targetApiUrl: "https://api.github.com",
    sourceOrg: "source-org-sentinel",
    sourceRepo: "internal-repo-sentinel",
    targetOrg: "target-org-sentinel",
    targetRepo: "internal-repo-sentinel",
    state: "failed",
    failureReason: null,
    migrationLogUrl: null,
    warningsCount: 0,
    sourceCounts: null,
    targetCounts: null,
    sourceSizeKb: null,
    startedAt: "2026-08-15T12:00:00.000Z",
    completedAt: "2026-08-15T12:01:00.000Z",
    elapsedSeconds: 60,
    authMode: null,
    requestOptions: null,
  };
}

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];

  process.env.GH_SOURCE_API_URL = "https://internal-source.example.com/api/v3";
  process.env.GH_SOURCE_ORG = "source-org-sentinel";
  process.env.GH_TARGET_ORG = "target-org-sentinel";
  process.env.GH_SOURCE_APP_ID = "internal-app-id";
  process.env.GH_SOURCE_APP_PRIVATE_KEY = "private-key-sentinel";
  process.env.GH_SOURCE_APP_INSTALLATION_ID = "12345";
  process.env.GHES_TARGET_NAME = "Internal target sentinel";
  process.env.GHES_TARGET_API_URL = "https://internal-target.example.com/api/v3";
  process.env.GHES_TARGET_ORG = "target-org-sentinel";
  process.env.GITLAB_SOURCE_NAMESPACE = "gitlab-namespace-sentinel";
  process.env.BITBUCKET_SERVER_PROJECT_KEYS = "BITBUCKET-SENTINEL";

  initStore(":memory:", DOMAIN_STORES);
  insertMigration(sentinelMigration());
  insertEvent({
    migrationId: "layout-sentinel",
    eventType: "failure",
    phase: null,
    payload: { error: "failure-summary-sentinel" },
    createdAt: "2026-08-15T12:00:00.000Z",
  });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("root layout authentication boundary", () => {
  test("returns only the public contract without a session", async () => {
    const data = await loadLayout(true);
    expect(data).toEqual({ authEnabled: true });
    expectNoSentinels(data);
  });

  test("retains operational data for a valid session", async () => {
    const data = await loadLayout(true, AUTHENTICATED_USER);
    const serialized = JSON.stringify(data);
    expect(data.currentUser).toEqual(AUTHENTICATED_USER);
    expect(serialized).toContain("internal-source.example.com");
    expect(serialized).toContain("internal-repo-sentinel");
    expect(serialized).toContain("failure-summary-sentinel");
  });

  test("retains operational data when authentication is disabled", async () => {
    const data = await loadLayout(false);
    const serialized = JSON.stringify(data);
    expect(data.authEnabled).toBe(false);
    expect(serialized).toContain("internal-source.example.com");
    expect(serialized).toContain("internal-repo-sentinel");
    expect(serialized).toContain("failure-summary-sentinel");
  });
});
