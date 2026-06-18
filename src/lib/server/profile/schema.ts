/**
 * The Profile domain's persistence contribution: its table DDL and the startup
 * recovery that fails any profiling run interrupted by a restart.
 *
 * Registered via `$lib/server/registry` so {@link initStore} applies it at
 * startup. The query functions live in `./store`.
 */
import type { Database } from "bun:sqlite";
import { addColumnIfMissing, type DomainStore } from "$lib/server/core/db";

const PROFILE_DDL = `
  -- An enterprise-scoped readiness crawl: a parent that fans out to one child
  -- profile_runs row per organization. Aggregate counters are recomputed from
  -- its children as they settle.
  CREATE TABLE IF NOT EXISTS profile_enterprise_runs (
    id TEXT PRIMARY KEY,
    source_api_url TEXT NOT NULL,
    enterprise_slug TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'running',
    total_orgs INTEGER NOT NULL DEFAULT 0,
    profiled_orgs INTEGER NOT NULL DEFAULT 0,
    inaccessible_orgs INTEGER NOT NULL DEFAULT 0,
    total_repos INTEGER NOT NULL DEFAULT 0,
    profiled_repos INTEGER NOT NULL DEFAULT 0,
    blockers INTEGER NOT NULL DEFAULT 0,
    warnings INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    failure_reason TEXT
  );

  -- An organization-scoped readiness crawl. Aggregate counters (profiled_repos,
  -- blockers, warnings) are recomputed from profile_repos at completion, so they
  -- stay correct even if a repo is re-recorded on a resumed run. A run may belong
  -- to an enterprise run (enterprise_run_id) or stand alone (NULL).
  CREATE TABLE IF NOT EXISTS profile_runs (
    id TEXT PRIMARY KEY,
    source_api_url TEXT NOT NULL,
    org TEXT NOT NULL,
    enterprise_run_id TEXT REFERENCES profile_enterprise_runs(id),
    state TEXT NOT NULL DEFAULT 'running',
    total_repos INTEGER NOT NULL DEFAULT 0,
    profiled_repos INTEGER NOT NULL DEFAULT 0,
    blockers INTEGER NOT NULL DEFAULT 0,
    warnings INTEGER NOT NULL DEFAULT 0,
    org_ruleset_count INTEGER NOT NULL DEFAULT 0,
    org_resources TEXT NOT NULL DEFAULT '{}',
    api_calls INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    failure_reason TEXT
  );

  -- One repository's consideration analysis within a run.
  -- UNIQUE(run_id, name_with_owner) makes re-recording idempotent (upsert),
  -- which a resumed crawl relies on. \`enriched\` marks a repo that finished the
  -- final per-repo pass, so a resumed run can skip it.
  CREATE TABLE IF NOT EXISTS profile_repos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES profile_runs(id),
    name_with_owner TEXT NOT NULL,
    signals TEXT NOT NULL DEFAULT '{}',
    blockers INTEGER NOT NULL DEFAULT 0,
    warnings INTEGER NOT NULL DEFAULT 0,
    infos INTEGER NOT NULL DEFAULT 0,
    applying_considerations TEXT NOT NULL DEFAULT '[]',
    enriched INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    UNIQUE(run_id, name_with_owner)
  );

  CREATE INDEX IF NOT EXISTS idx_profile_repos_run_id ON profile_repos(run_id);
  CREATE INDEX IF NOT EXISTS idx_profile_runs_state ON profile_runs(state);
  CREATE INDEX IF NOT EXISTS idx_profile_enterprise_runs_state ON profile_enterprise_runs(state);
`;

/**
 * Fail every profiling run still marked `running` (org runs, enterprise runs,
 * and child runs). Used by the service's startup recovery when no source
 * credentials are available to resume — and by tests. When credentials ARE
 * available the service resumes these runs instead, so this isn't wired to the
 * store's `onInit`: the service is the single startup authority.
 */
export function recoverInterruptedProfiles(db: Database, nowMs: number = Date.now()): void {
  const isoNow = new Date(nowMs).toISOString();
  const orphaned = db
    .prepare(
      `UPDATE profile_runs
       SET state = 'failed',
           failure_reason = 'Server restarted during profiling',
           completed_at = ?
       WHERE state = 'running'`,
    )
    .run(isoNow);
  if (orphaned.changes > 0) {
    console.log(`[profile] Marked ${orphaned.changes} interrupted profiling run(s) as failed`);
  }
  const orphanedEnterprises = db
    .prepare(
      `UPDATE profile_enterprise_runs
       SET state = 'failed',
           failure_reason = 'Server restarted during profiling',
           completed_at = ?
       WHERE state = 'running'`,
    )
    .run(isoNow);
  if (orphanedEnterprises.changes > 0) {
    console.log(
      `[profile] Marked ${orphanedEnterprises.changes} interrupted enterprise run(s) as failed`,
    );
  }
}

/** Profile domain store descriptor — see `$lib/server/registry`. */
export const profileStore: DomainStore = {
  applySchema(db) {
    db.run(PROFILE_DDL);
    // Columns added after the table's first release — upgrade older databases.
    addColumnIfMissing(db, "profile_runs", "org_ruleset_count", "INTEGER NOT NULL DEFAULT 0");
    addColumnIfMissing(db, "profile_runs", "org_resources", "TEXT NOT NULL DEFAULT '{}'");
    addColumnIfMissing(db, "profile_runs", "api_calls", "INTEGER NOT NULL DEFAULT 0");
    addColumnIfMissing(db, "profile_runs", "enterprise_run_id", "TEXT");
    addColumnIfMissing(db, "profile_repos", "enriched", "INTEGER NOT NULL DEFAULT 0");
    addColumnIfMissing(
      db,
      "profile_enterprise_runs",
      "inaccessible_orgs",
      "INTEGER NOT NULL DEFAULT 0",
    );
    // Index the new column AFTER it's guaranteed to exist (a pre-existing DB
    // adds it via addColumnIfMissing above; the CREATE TABLE only covers fresh
    // DBs), so an upgrade doesn't fail building an index on a missing column.
    db.run(
      "CREATE INDEX IF NOT EXISTS idx_profile_runs_enterprise ON profile_runs(enterprise_run_id)",
    );
    healRepoTotals(db);
  },
  // No onInit recovery: interrupted runs are left `running` for the service's
  // `resumeInterruptedProfiles` to resume (or fail, when it can't) at startup.
};

/**
 * Clamp every run's `total_repos` up to the number of repos it actually
 * recorded, then re-roll enterprise repo aggregates from the corrected children.
 *
 * Idempotent — a no-op once totals are consistent. Heals data written before the
 * resume "union" fix, where a rate-limited re-discovery on resume could persist a
 * `total_repos` below `profiled_repos` (the page showing e.g. "10123/92"). The
 * enterprise totals are sums of their children, so they're re-rolled to follow.
 */
function healRepoTotals(db: Database): void {
  db.run(
    `UPDATE profile_runs SET total_repos = (
       SELECT COUNT(*) FROM profile_repos WHERE profile_repos.run_id = profile_runs.id
     )
     WHERE total_repos < (
       SELECT COUNT(*) FROM profile_repos WHERE profile_repos.run_id = profile_runs.id
     )`,
  );
  db.run(
    `UPDATE profile_enterprise_runs SET
       total_repos = (SELECT COALESCE(SUM(total_repos), 0) FROM profile_runs
                      WHERE enterprise_run_id = profile_enterprise_runs.id),
       profiled_repos = (SELECT COALESCE(SUM(profiled_repos), 0) FROM profile_runs
                         WHERE enterprise_run_id = profile_enterprise_runs.id)`,
  );
}
