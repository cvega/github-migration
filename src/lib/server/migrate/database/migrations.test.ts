import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  parsePersistedRequestOptions,
  tryParsePersistedRequestOptions,
} from "$lib/migrate/request-options";
import type { Migration } from "$lib/migrate/types";
import { closeStore, initStore } from "$lib/server/core/db";
import {
  claimMigrationCancellation,
  getBatchMigrationByItem,
  getMigration,
  getNextQueuedMigration,
  getRecoverableMigrations,
  getResumableSourceExportId,
  hasMigrationHistory,
  insertMigration,
  likePattern,
  listMigrationsPaginated,
  parsePersistedCounts,
  parsePersistedEventPayload,
  rowsToMigrations,
  rowToMigration,
  searchMigrationsPaginated,
  updateMigrationState,
  updateSourceExportCheckpoint,
} from "./migrations";
import { migrateStore } from "./schema";

const counts = {
  commits: 10,
  branches: 2,
  tags: 1,
  issues: 4,
  pullRequests: 3,
  releases: 1,
};

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "migration-1",
    batch_id: null,
    github_migration_id: null,
    source_provider: "github",
    source_api_url: "https://api.github.com",
    target_profile_id: "ghec",
    target_platform: "ghec",
    target_api_url: "https://api.github.com",
    source_org: "acme",
    source_repo: "widget",
    target_org: "acme-cloud",
    target_repo: "widget",
    state: "pending",
    warnings_count: 0,
    source_counts: null,
    target_counts: null,
    started_at: "2026-08-17T12:00:00.000Z",
    ...overrides,
  };
}

describe("persisted migration records", () => {
  test("strictly parses count snapshots", () => {
    expect(parsePersistedCounts(JSON.stringify(counts))).toEqual(counts);
    expect(() => parsePersistedCounts("{bad-json")).toThrow("Invalid stored migration counts");
    expect(() => parsePersistedCounts(JSON.stringify({ ...counts, commits: "10" }))).toThrow();
    expect(() => parsePersistedCounts(JSON.stringify({ ...counts, extra: 1 }))).toThrow();
  });

  test("accepts optional nonsecret request settings but rejects unknown fields", () => {
    expect(parsePersistedRequestOptions("{}")).toEqual({});
    expect(
      parsePersistedRequestOptions(
        JSON.stringify({ sourceRepo: "acme/widget", skipReleases: true }),
      ),
    ).toEqual({ sourceRepo: "acme/widget", skipReleases: true });
    expect(tryParsePersistedRequestOptions(JSON.stringify({ futureOption: true }))).toBeNull();
  });

  test("validates event payloads against their discriminator", () => {
    expect(parsePersistedEventPayload("step", JSON.stringify({ message: "Exporting" }))).toEqual({
      message: "Exporting",
    });
    expect(() =>
      parsePersistedEventPayload("restart", JSON.stringify({ message: "Restart" })),
    ).toThrow();
    expect(() => parsePersistedEventPayload("step", JSON.stringify({ message: 1 }))).toThrow();
  });

  test("hydrates nullable observations and requires the stored warning count", () => {
    expect(rowToMigration(row())).toMatchObject({
      id: "migration-1",
      sourceProvider: "github",
      targetPlatform: "ghec",
      warningsCount: 0,
      sourceCounts: null,
      authMode: null,
    });
    expect(rowsToMigrations([row({ warnings_count: null }), row()]).map(({ id }) => id)).toEqual([
      "migration-1",
    ]);
    expect(() => rowToMigration(row({ warnings_count: null }))).toThrow("invalid warnings_count");
    expect(() => rowToMigration(row({ source_provider: "unknown" }))).toThrow(
      "invalid source_provider",
    );
  });

  test("escapes SQL LIKE metacharacters", () => {
    expect(likePattern("acme_100%\\done")).toBe("%acme\\_100\\%\\\\done%");
  });
});

function migration(overrides: Partial<Migration> = {}): Migration {
  return {
    id: "migration-1",
    batchId: null,
    githubMigrationId: null,
    sourceProvider: "github",
    sourceApiUrl: "https://api.github.com",
    targetProfileId: "ghec",
    targetPlatform: "ghec",
    targetApiUrl: "https://api.github.com",
    sourceOrg: "acme",
    sourceRepo: "widget",
    targetOrg: "acme-cloud",
    targetRepo: "widget",
    state: "pending",
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
    ...overrides,
  };
}

describe("migration database lifecycle", () => {
  beforeEach(() => initStore(":memory:", [migrateStore]));
  afterEach(closeStore);

  test("atomically inserts migrations and batch item identity", () => {
    const item = migration({ id: "batch-item", batchId: "batch-1" });
    insertMigration(item);
    expect(getMigration(item.id)).toEqual(item);
    expect(getBatchMigrationByItem("batch-1", "acme", "widget", "widget")).toEqual(item);
  });

  test("persists only the explicitly configured insecure Bitbucket source", () => {
    const previousUrl = process.env.BITBUCKET_SERVER_URL;
    const previousOverride = process.env.BITBUCKET_SERVER_ALLOW_INSECURE_HTTP;
    const item = migration({
      sourceProvider: "bitbucket-server",
      sourceApiUrl: "http://bitbucket:7990/rest/api/1.0",
    });
    try {
      process.env.BITBUCKET_SERVER_URL = "http://bitbucket:7990";
      delete process.env.BITBUCKET_SERVER_ALLOW_INSECURE_HTTP;
      expect(() => insertMigration(item)).toThrow("must use HTTPS");

      process.env.BITBUCKET_SERVER_ALLOW_INSECURE_HTTP = "true";
      expect(() =>
        insertMigration({ ...item, sourceApiUrl: "http://other:7990/rest/api/1.0" }),
      ).toThrow("must match the configured Bitbucket Server URL");
      expect(() =>
        insertMigration({
          ...item,
          sourceApiUrl: "http://user:secret@bitbucket:7990/rest/api/1.0",
        }),
      ).toThrow("must not include credentials");
      expect(() => insertMigration({ ...item, sourceProvider: "github" })).toThrow(
        "must use HTTPS",
      );
      expect(() =>
        insertMigration({ ...item, targetApiUrl: "http://ghes.example.com/api/v3" }),
      ).toThrow("must use HTTPS");

      insertMigration(item);
      expect(getMigration(item.id)?.sourceApiUrl).toBe(item.sourceApiUrl);
    } finally {
      if (previousUrl === undefined) delete process.env.BITBUCKET_SERVER_URL;
      else process.env.BITBUCKET_SERVER_URL = previousUrl;
      if (previousOverride === undefined) delete process.env.BITBUCKET_SERVER_ALLOW_INSECURE_HTTP;
      else process.env.BITBUCKET_SERVER_ALLOW_INSECURE_HTTP = previousOverride;
    }
  });

  test("updates durable state details while preserving a claimed cancellation", () => {
    insertMigration(migration({ state: "running" }));
    expect(claimMigrationCancellation("migration-1")).toBe(true);
    expect(
      updateMigrationState(
        "migration-1",
        "succeeded",
        { completedAt: "2026-08-17T12:10:00.000Z", elapsedSeconds: 600 },
        true,
      ),
    ).toBe(false);
    expect(getMigration("migration-1")?.state).toBe("cancelling");
  });

  test("selects only environment-authenticated resumable source work", () => {
    insertMigration(
      migration({
        id: "recoverable",
        sourceProvider: "bitbucket-server",
        sourceApiUrl: "https://bitbucket.example.com/rest/api/1.0",
        state: "running",
        authMode: "env-pat",
      }),
    );
    insertMigration(migration({ id: "request-auth", state: "running", authMode: "request-pat" }));
    updateSourceExportCheckpoint("recoverable", "source_export", "42");
    expect(getResumableSourceExportId("recoverable")).toBe("42");
    expect(getRecoverableMigrations().map(({ id }) => id)).toEqual(["recoverable"]);
    expect(() => updateSourceExportCheckpoint("recoverable", "source_export", "0")).toThrow();
  });

  test("hydrates only the requested page of matching count snapshots", () => {
    for (const id of ["a", "b", "c", "d"]) insertMigration(migration({ id, sourceCounts: counts }));
    using parse = spyOn(JSON, "parse");
    expect(hasMigrationHistory()).toBe(true);
    expect(parse).not.toHaveBeenCalled();
    for (const page of [
      listMigrationsPaginated,
      (params: { page: number; limit: number }) =>
        searchMigrationsPaginated({ ...params, q: "widget" }),
    ]) {
      parse.mockClear();
      const result = page({ page: 2, limit: 1 });
      expect(result.total).toBe(4);
      expect(result.data).toHaveLength(1);
      expect(parse.mock.calls.filter(([text]) => text === JSON.stringify(counts))).toHaveLength(1);
    }
  });

  test("paginates, escapes searches, and returns the oldest queued migration", () => {
    insertMigration(migration({ id: "older", state: "queued", startedAt: "2026-08-17T12:00:00Z" }));
    insertMigration(
      migration({
        id: "newer",
        sourceRepo: "widget_100%",
        state: "queued",
        startedAt: "2026-08-17T13:00:00Z",
      }),
    );
    expect(listMigrationsPaginated({ page: 1, limit: 1 })).toMatchObject({
      total: 2,
      totalPages: 2,
      data: [{ id: "newer" }],
    });
    expect(searchMigrationsPaginated({ page: 1, limit: 10, q: "widget_100%" }).data).toHaveLength(
      1,
    );
    expect(getNextQueuedMigration()?.id).toBe("older");
  });
});
