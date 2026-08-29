import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Migration } from "$lib/migrate/types";
import { getCachedLiveRateLimits } from "$lib/server/core/auth";
import { initStore } from "$lib/server/core/db";
import { getCachedGitHubStatus } from "$lib/server/core/github-status";
import { insertMigration } from "$lib/server/migrate/database/migrations";
import { DOMAIN_STORES } from "$lib/server/schemas";
import { GET } from "./+server";

const realDateNow = Date.now;

beforeEach(() => {
  Date.now = () => 0;
  initStore(":memory:", DOMAIN_STORES);
  const migration: Migration = {
    id: "rate-limit-active",
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
});

afterEach(() => {
  Date.now = realDateNow;
});

describe("GET provider rate limits", () => {
  test("combines provider, platform, and active migration state", async () => {
    const rates = getCachedLiveRateLimits();
    const ghStatus = getCachedGitHubStatus();

    const response = await GET({} as Parameters<typeof GET>[0]);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      source: rates.source,
      target: rates.target,
      activeMigrations: 1,
      ghStatus,
    });
  });
});
