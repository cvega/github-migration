/**
 * The Profile domain's persistence contribution: its table DDL. Registered via
 * `$lib/server/registry` so {@link initStore} applies it at startup. The query
 * functions live in `./store`.
 */
import type { DomainStore } from "$lib/server/core/db";

const PROFILE_DDL = `
  -- An organization-scoped readiness crawl. Aggregate counters (profiled_repos,
  -- blockers, warnings) are recomputed from profile_repos at completion, so they
  -- stay correct even if a repo is re-recorded on a resumed run.
  CREATE TABLE IF NOT EXISTS profile_runs (
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

  -- One repository's consideration analysis within a run.
  -- UNIQUE(run_id, name_with_owner) makes re-recording idempotent (upsert),
  -- which a resumed crawl relies on.
  CREATE TABLE IF NOT EXISTS profile_repos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES profile_runs(id),
    name_with_owner TEXT NOT NULL,
    signals TEXT NOT NULL DEFAULT '{}',
    blockers INTEGER NOT NULL DEFAULT 0,
    warnings INTEGER NOT NULL DEFAULT 0,
    infos INTEGER NOT NULL DEFAULT 0,
    applying_considerations TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    UNIQUE(run_id, name_with_owner)
  );

  CREATE INDEX IF NOT EXISTS idx_profile_repos_run_id ON profile_repos(run_id);
  CREATE INDEX IF NOT EXISTS idx_profile_runs_state ON profile_runs(state);
`;

/** Profile domain store descriptor — see `$lib/server/registry`. */
export const profileStore: DomainStore = {
  applySchema(db) {
    db.run(PROFILE_DDL);
  },
};
