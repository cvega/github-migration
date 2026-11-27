import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Counts, Migration } from "$lib/migrate/types";
import { closeStore, getDb, initStore } from "$lib/server/core/db";
import {
  getMigration,
  insertMigration,
  updateMigrationState,
} from "$lib/server/migrate/database/migrations";
import { migrateStore } from "$lib/server/migrate/database/schema";
import { targetCountDependencies } from "$lib/server/migrate/target-counts";
import { actions, load } from "./+page.server";

const counts: Counts = {
  commits: 1,
  branches: 3,
  tags: 0,
  issues: 0,
  pullRequests: 2,
  releases: 0,
};
const keys = [
  "GH_TARGET_PAT",
  "GH_TARGET_APP_ID",
  "GH_TARGET_APP_PRIVATE_KEY",
  "GH_TARGET_APP_INSTALLATION_ID",
  "GHES_TARGET_ID",
  "GHES_TARGET_API_URL",
  "GHES_TARGET_ADMIN_PAT",
] as const;
const saved = new Map<string, string | undefined>();
const originalGetCounts = targetCountDependencies.getRepoCounts;
let reads: Array<{ url: string; auth: unknown; owner: string; repo: string }> = [];

function migration(platform: "ghec" | "ghes" = "ghes"): Migration {
  return {
    id: "completed-counts",
    batchId: null,
    githubMigrationId: null,
    sourceProvider: "bitbucket-server",
    sourceApiUrl: "https://bitbucket.example/rest/api/1.0",
    targetProfileId: platform,
    targetPlatform: platform,
    targetApiUrl: platform === "ghes" ? "https://ghes.example/api/v3" : "https://api.github.com",
    sourceOrg: "TEST",
    sourceRepo: "repo",
    targetOrg: "destination",
    targetRepo: "repo",
    state: "succeeded",
    failureReason: null,
    migrationLogUrl: null,
    warningsCount: 0,
    sourceCounts: null,
    targetCounts: null,
    sourceSizeKb: null,
    startedAt: "2026-11-20T17:00:00.000Z",
    completedAt: "2026-11-20T17:01:30.000Z",
    elapsedSeconds: 90,
    authMode: "env-pat",
    requestOptions: "{}",
  };
}

function refresh(id = "completed-counts") {
  const action = actions.refreshCounts;
  if (!action) throw new Error("Missing count refresh action");
  return action({ params: { id } } as never);
}

function persistMigration(record: Migration): void {
  insertMigration(record);
  updateMigrationState(record.id, record.state, {
    completedAt: record.completedAt ?? undefined,
    elapsedSeconds: record.elapsedSeconds ?? undefined,
  });
}

beforeEach(() => {
  initStore(":memory:", [migrateStore]);
  for (const key of keys) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.GH_TARGET_PAT = "cloud-token";
  process.env.GHES_TARGET_ADMIN_PAT = "server-token";
  process.env.GHES_TARGET_API_URL = "https://ghes.example";
  reads = [];
  targetCountDependencies.getRepoCounts = async (client, _gql, owner, repo) => {
    reads.push({
      url: client.request.endpoint.DEFAULTS.baseUrl,
      auth: await client.auth(),
      owner,
      repo,
    });
    return counts;
  };
});

afterEach(() => {
  targetCountDependencies.getRepoCounts = originalGetCounts;
  closeStore();
  for (const key of keys) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

test("offers review of a paused route only while an unresolved GHES import holds the slot", async () => {
  const record: Migration = {
    ...migration(),
    sourceProvider: "gitlab",
    state: "reconciliation_required",
  };
  persistMigration(record);
  const event = { params: { id: record.id } } as never;
  expect(await load(event)).toMatchObject({ canReviewRemote: false });
  getDb()
    .prepare(`INSERT INTO ghes_import_jobs (id, migration_id, phase, created_at, updated_at)
      VALUES ('job', ?, 'preparing', '', '')`)
    .run(record.id);
  expect(await load(event)).toMatchObject({ canReviewRemote: true });
});

describe("completed migration resource counts", () => {
  test.each(["ghes", "ghec"] as const)(
    "shows current %s counts without attributing later or replacement repository data to the migration",
    async (platform) => {
      const record = migration(platform);
      persistMigration(record);

      expect(await refresh()).toMatchObject({
        currentTarget: { id: record.id, counts, observedAt: expect.any(String) },
      });
      expect(reads).toEqual([
        {
          url: record.targetApiUrl,
          auth: {
            type: "token",
            tokenType: "oauth",
            token: platform === "ghes" ? "server-token" : "cloud-token",
          },
          owner: "destination",
          repo: "repo",
        },
      ]);
      expect(getMigration(record.id)).toMatchObject(record);
      expect(await load({ params: { id: record.id } } as never)).toMatchObject({
        migration: { state: "succeeded", targetCounts: null, elapsedSeconds: 90 },
      });
      const replacement = { ...counts, branches: 42 };
      targetCountDependencies.getRepoCounts = async () => replacement;
      expect(await refresh()).toMatchObject({ currentTarget: { counts: replacement } });
      expect(getMigration(record.id)?.targetCounts).toBeNull();
    },
  );

  test("reports count failures without replacing unknown totals or changing the import outcome", async () => {
    using warning = spyOn(console, "warn").mockImplementation(() => {});
    const record = migration();
    persistMigration(record);
    targetCountDependencies.getRepoCounts = async () => {
      throw new Error("private upstream diagnostic");
    };

    expect(await refresh()).toMatchObject({
      status: 502,
      data: { countsError: "Could not fetch target resource counts: Target API unavailable" },
    });
    expect(JSON.stringify(warning.mock.calls)).not.toContain("private upstream diagnostic");
    expect(getMigration(record.id)).toMatchObject(record);
  });

  test("preserves a recorded empty repository instead of refetching or treating zero as unknown", async () => {
    const record = {
      ...migration(),
      targetCounts: { ...counts, commits: 0, branches: 0, pullRequests: 0 },
    };
    persistMigration(record);
    expect(await refresh()).toEqual({ countsCollected: true });
    expect(reads).toHaveLength(0);
    expect(getMigration(record.id)).toMatchObject(record);
  });

  test("rejects missing and unfinished migrations before making target requests", async () => {
    expect(await refresh()).toMatchObject({ status: 404 });
    for (const state of ["running", "failed", "reconciliation_required"] as const) {
      const record = { ...migration(), id: state, state };
      persistMigration(record);
      expect(await refresh(record.id)).toMatchObject({ status: 409 });
      expect(getMigration(record.id)).toMatchObject(record);
    }
    expect(reads).toHaveLength(0);
  });

  test("does not send credentials when the configured target no longer matches the migration", async () => {
    persistMigration(migration());
    process.env.GHES_TARGET_API_URL = "https://replacement.example";
    expect(await refresh()).toMatchObject({
      status: 502,
      data: { countsError: expect.stringContaining("configured target has changed") },
    });
    expect(reads).toHaveLength(0);
    expect(getMigration("completed-counts")?.targetCounts).toBeNull();
  });

  test("does not change lifecycle state if a migration changes during the count request", async () => {
    persistMigration(migration());
    targetCountDependencies.getRepoCounts = async () => {
      updateMigrationState("completed-counts", "reconciliation_required");
      return counts;
    };
    expect(await refresh()).toMatchObject({ status: 409 });
    expect(getMigration("completed-counts")).toMatchObject({
      state: "reconciliation_required",
      targetCounts: null,
    });
  });
});
