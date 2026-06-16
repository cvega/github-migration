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
 * On startup, fail profiling runs interrupted by a restart so a detail page
 * doesn't poll a run that can never settle. Standalone org runs are recoverable
 * (their work survives in `profile_repos`), so when `leaveStandaloneOrgRuns` is
 * set they're left `running` for the service's `resumeInterruptedProfiles` to
 * continue; everything else — enterprise runs and their child org runs — is
 * failed (enterprise resume isn't wired here).
 *
 * Called with no options by tests (fails every running run); the store's
 * `onInit` passes `leaveStandaloneOrgRuns: true` so production can resume.
 */
export function recoverInterruptedProfiles(
  db: Database,
  nowMs: number = Date.now(),
  opts: { leaveStandaloneOrgRuns?: boolean } = {},
): void {
  const isoNow = new Date(nowMs).toISOString();
  // Standalone org runs (no enterprise parent) are left for the service to
  // resume when requested; child runs are always failed here.
  const orgWhere = opts.leaveStandaloneOrgRuns
    ? "state = 'running' AND enterprise_run_id IS NOT NULL"
    : "state = 'running'";
  const orphaned = db
    .prepare(
      `UPDATE profile_runs
       SET state = 'failed',
           failure_reason = 'Server restarted during profiling',
           completed_at = ?
       WHERE ${orgWhere}`,
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
    // Index the new column AFTER it's guaranteed to exist (a pre-existing DB
    // adds it via addColumnIfMissing above; the CREATE TABLE only covers fresh
    // DBs), so an upgrade doesn't fail building an index on a missing column.
    db.run(
      "CREATE INDEX IF NOT EXISTS idx_profile_runs_enterprise ON profile_runs(enterprise_run_id)",
    );
  },
  // Leave standalone org runs `running` so the service can resume them; fail the
  // rest (enterprise runs + their child org runs).
  onInit: (db) => recoverInterruptedProfiles(db, Date.now(), { leaveStandaloneOrgRuns: true }),
};
