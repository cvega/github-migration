/**
 * Tests for the Profile domain's startup recovery. A profile crawl runs
 * entirely in-process, so a run left in `running` by a restart can never settle
 * and must be failed on the next boot. Each test runs against a fresh in-memory
 * store with an injected clock.
 */
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { getDb, initStore } from "$lib/server/core/db";
import { DOMAIN_STORES } from "$lib/server/registry";
import { profileStore, recoverInterruptedProfiles } from "./schema";
import {
  completeProfileRun,
  createEnterpriseRun,
  createProfileRun,
  failProfileRun,
  getEnterpriseRun,
  getProfileRun,
} from "./store";

const NOW = Date.parse("2026-06-14T00:00:00Z");

beforeEach(() => {
  initStore(":memory:", DOMAIN_STORES);
});

describe("recoverInterruptedProfiles", () => {
  test("fails a run left in the running state", () => {
    createProfileRun({ id: "r", sourceApiUrl: "u", org: "acme" });

    recoverInterruptedProfiles(getDb(), NOW);

    const run = getProfileRun("r");
    expect(run?.state).toBe("failed");
    expect(run?.failureReason).toBe("Server restarted during profiling");
    expect(run?.completedAt).toBe("2026-06-14T00:00:00.000Z");
  });

  test("fails every interrupted run", () => {
    createProfileRun({ id: "a", sourceApiUrl: "u", org: "acme" });
    createProfileRun({ id: "b", sourceApiUrl: "u", org: "acme" });

    recoverInterruptedProfiles(getDb(), NOW);

    expect(getProfileRun("a")?.state).toBe("failed");
    expect(getProfileRun("b")?.state).toBe("failed");
  });

  test("leaves a completed run untouched", () => {
    createProfileRun({ id: "done", sourceApiUrl: "u", org: "acme" });
    completeProfileRun("done", NOW);
    const before = getProfileRun("done");

    recoverInterruptedProfiles(getDb(), NOW);

    expect(getProfileRun("done")).toEqual(before);
  });

  test("preserves an existing failure reason", () => {
    createProfileRun({ id: "boom", sourceApiUrl: "u", org: "acme" });
    failProfileRun("boom", "discovery exploded", NOW);

    recoverInterruptedProfiles(getDb(), NOW);

    expect(getProfileRun("boom")?.failureReason).toBe("discovery exploded");
  });

  test("is a no-op when nothing is running", () => {
    expect(() => recoverInterruptedProfiles(getDb(), NOW)).not.toThrow();
  });

  test("fails running enterprise runs too", () => {
    createEnterpriseRun({ id: "ent", sourceApiUrl: "u", enterpriseSlug: "acme-inc" });
    createProfileRun({ id: "child", sourceApiUrl: "u", org: "team", enterpriseRunId: "ent" });

    recoverInterruptedProfiles(getDb(), NOW);

    expect(getEnterpriseRun("ent")?.state).toBe("failed");
    expect(getProfileRun("child")?.state).toBe("failed");
  });
});

describe("profileStore.applySchema (upgrade path)", () => {
  /** Column names present on a table, via PRAGMA table_info. */
  function columns(db: Database, table: string): string[] {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  /** Whether an index exists, via PRAGMA index_list. */
  function hasIndex(db: Database, table: string, index: string): boolean {
    const rows = db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>;
    return rows.some((r) => r.name === index);
  }

  test("upgrades a pre-enterprise database without throwing", () => {
    // A database created before enterprise profiling: profile_runs exists with
    // the original columns, with no enterprise_run_id and no profile_enterprise_runs.
    const db = new Database(":memory:", { create: true });
    db.run(`
      CREATE TABLE profile_runs (
        id TEXT PRIMARY KEY,
        source_api_url TEXT NOT NULL,
        org TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'running',
        total_repos INTEGER NOT NULL DEFAULT 0,
        profiled_repos INTEGER NOT NULL DEFAULT 0,
        blockers INTEGER NOT NULL DEFAULT 0,
        warnings INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        failure_reason TEXT
      );
      CREATE TABLE profile_repos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        name_with_owner TEXT NOT NULL,
        signals TEXT NOT NULL DEFAULT '{}',
        blockers INTEGER NOT NULL DEFAULT 0,
        warnings INTEGER NOT NULL DEFAULT 0,
        infos INTEGER NOT NULL DEFAULT 0,
        applying_considerations TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        UNIQUE(run_id, name_with_owner)
      );
      CREATE INDEX idx_profile_runs_state ON profile_runs(state);
    `);

    // The regression: applying the current schema must not fail building the
    // enterprise index against the not-yet-added column.
    expect(() => profileStore.applySchema(db)).not.toThrow();

    // The new columns, table, and index are all present after the upgrade.
    expect(columns(db, "profile_runs")).toContain("enterprise_run_id");
    expect(columns(db, "profile_runs")).toContain("api_calls");
    expect(columns(db, "profile_repos")).toContain("enriched");
    expect(hasIndex(db, "profile_runs", "idx_profile_runs_enterprise")).toBe(true);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain("profile_enterprise_runs");

    db.close();
  });

  test("is idempotent — applying twice is a no-op the second time", () => {
    const db = new Database(":memory:", { create: true });
    profileStore.applySchema(db);
    expect(() => profileStore.applySchema(db)).not.toThrow();
    expect(hasIndex(db, "profile_runs", "idx_profile_runs_enterprise")).toBe(true);
    db.close();
  });

  test("heals runs whose total_repos drifted below the recorded count", () => {
    const db = new Database(":memory:", { create: true });
    profileStore.applySchema(db);

    // An enterprise with a child whose total_repos (2) is below the repos it
    // actually recorded (3) — the "10123/92" corruption in miniature.
    db.run(
      `INSERT INTO profile_enterprise_runs (id, source_api_url, enterprise_slug, state, total_repos, profiled_repos, started_at)
       VALUES ('ent', 'u', 'acme', 'completed', 2, 3, '2026-06-15T00:00:00Z')`,
    );
    db.run(
      `INSERT INTO profile_runs (id, source_api_url, org, enterprise_run_id, state, total_repos, profiled_repos, started_at)
       VALUES ('child', 'u', 'big', 'ent', 'completed', 2, 3, '2026-06-15T00:00:00Z')`,
    );
    for (const name of ["big/a", "big/b", "big/c"]) {
      db.run(
        `INSERT INTO profile_repos (run_id, name_with_owner, created_at) VALUES ('child', ?, '2026-06-15T00:00:00Z')`,
        [name],
      );
    }

    // Re-applying the schema heals the drift.
    profileStore.applySchema(db);

    const child = db.prepare("SELECT total_repos FROM profile_runs WHERE id = 'child'").get() as {
      total_repos: number;
    };
    expect(child.total_repos).toBe(3); // clamped up from 2
    const ent = db
      .prepare("SELECT total_repos, profiled_repos FROM profile_enterprise_runs WHERE id = 'ent'")
      .get() as { total_repos: number; profiled_repos: number };
    expect(ent.total_repos).toBe(3); // re-rolled from the healed child
    expect(ent.profiled_repos).toBe(3);
    db.close();
  });

  test("leaves correct totals untouched (heal is idempotent)", () => {
    const db = new Database(":memory:", { create: true });
    profileStore.applySchema(db);
    db.run(
      `INSERT INTO profile_runs (id, source_api_url, org, state, total_repos, profiled_repos, started_at)
       VALUES ('ok', 'u', 'acme', 'completed', 5, 2, '2026-06-15T00:00:00Z')`,
    );
    for (const name of ["acme/a", "acme/b"]) {
      db.run(
        `INSERT INTO profile_repos (run_id, name_with_owner, created_at) VALUES ('ok', ?, '2026-06-15T00:00:00Z')`,
        [name],
      );
    }
    profileStore.applySchema(db);
    const run = db.prepare("SELECT total_repos FROM profile_runs WHERE id = 'ok'").get() as {
      total_repos: number;
    };
    expect(run.total_repos).toBe(5); // 5 > 2 recorded → left as-is
    db.close();
  });
});
