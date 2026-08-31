/**
 * The Profile domain's persistence contribution: its table DDL and the startup
 * recovery that fails any profiling run interrupted by a restart.
 *
 * Registered via `$lib/server/schemas` so {@link initStore} applies it at
 * startup. The query functions live in `./store`.
 */
import type { Database } from "bun:sqlite";
import {
  addColumnIfMissing,
  type DomainStore,
  type DurableTableContract,
} from "$lib/server/core/db";
import { parseSourceNamespaceInventory } from "$lib/source/inventory";
import { SOURCE_PROVIDERS } from "$lib/source-provider";

export const PROFILE_DURABLE_TABLES = [
  {
    name: "profile_runs",
    purpose: "Profile lifecycle and rollups",
    notes: "Stores provider, namespace, counters, API calls, timestamps, and terminal failure",
  },
  {
    name: "profile_repos",
    purpose: "Repository analysis within a profile",
    notes: "Idempotent per run and repository; queried in filtered pages",
  },
  {
    name: "profile_source_inventories",
    purpose: "Provider-neutral inventory summary",
    notes: "One normalized summary per profile run",
  },
  {
    name: "profile_source_inventory_projects",
    purpose: "Source inventory projects",
    notes: "Ordered, normalized project rows for paginated access",
  },
  {
    name: "profile_source_project_profiles",
    purpose: "Provider-specific project profiles",
    notes: "Stores normalized per-project profile payloads keyed to inventory rows",
  },
  {
    name: "profile_repository_analysis_runs",
    purpose: "Repository analysis lifecycle and rollups",
    notes: "One nonterminal child run per completed GitHub profile",
  },
  {
    name: "profile_repository_analysis_jobs",
    purpose: "Durable repository analysis queue",
    notes: "One leased job per selected repository and analysis run",
  },
  {
    name: "profile_repository_analysis_results",
    purpose: "Immutable repository analysis evidence",
    notes: "Normalized Git metrics and bounded artifacts per job attempt",
  },
  {
    name: "profile_repository_analysis_lfs_pointers",
    purpose: "Historical LFS pointer evidence",
    notes: "Normalized OIDs, sizes, and representative paths per analysis result",
  },
] as const satisfies readonly DurableTableContract[];

const PROFILE_DDL = `
  -- An organization-scoped readiness crawl. Aggregate counters (profiled_repos,
  -- blockers, warnings) are recomputed from profile_repos at completion, so they
  -- stay correct even if a repo is re-recorded on a resumed run.
  CREATE TABLE IF NOT EXISTS profile_runs (
    id TEXT PRIMARY KEY,
    source_provider TEXT NOT NULL DEFAULT 'github',
    source_api_url TEXT NOT NULL,
    org TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'running',
    total_repos INTEGER NOT NULL DEFAULT 0,
    profiled_repos INTEGER NOT NULL DEFAULT 0,
    blockers INTEGER NOT NULL DEFAULT 0,
    warnings INTEGER NOT NULL DEFAULT 0,
    org_ruleset_count INTEGER NOT NULL DEFAULT 0,
    org_resources TEXT NOT NULL DEFAULT '{}',
    api_calls INTEGER NOT NULL DEFAULT 0,
    detail_rollup TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    failure_reason TEXT
  );

  -- One repository's migration catalog analysis within a run.
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

  -- Provider-neutral source inventory metadata captured for a profiling run.
  -- payload is retained only to backfill databases created before projects
  -- moved to normalized rows.
  CREATE TABLE IF NOT EXISTS profile_source_inventories (
    run_id TEXT PRIMARY KEY REFERENCES profile_runs(id) ON DELETE CASCADE,
    payload TEXT NOT NULL DEFAULT '{}',
    project_count TEXT NOT NULL DEFAULT '{"kind":"exact","value":0}',
    summary TEXT NOT NULL DEFAULT '{}',
    fetched_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS profile_source_inventory_projects (
    run_id TEXT NOT NULL REFERENCES profile_source_inventories(run_id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    source_id TEXT NOT NULL,
    path TEXT NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (run_id, source_id),
    UNIQUE (run_id, path),
    UNIQUE (run_id, position)
  );

  CREATE INDEX IF NOT EXISTS idx_profile_inventory_projects_run_id
    ON profile_source_inventory_projects(run_id, position);

  CREATE TABLE IF NOT EXISTS profile_source_project_profiles (
    run_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    path TEXT NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (run_id, source_id),
    UNIQUE (run_id, path),
    FOREIGN KEY (run_id, source_id)
      REFERENCES profile_source_inventory_projects(run_id, source_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS profile_repository_analysis_runs (
    id TEXT PRIMARY KEY,
    profile_run_id TEXT NOT NULL REFERENCES profile_runs(id) ON DELETE CASCADE,
    state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'finalizing', 'completed', 'failed', 'cancelled')),
    policy_version INTEGER NOT NULL DEFAULT 1,
    selected_repo_count INTEGER NOT NULL,
    completed_repo_count INTEGER NOT NULL DEFAULT 0,
    failed_repo_count INTEGER NOT NULL DEFAULT 0,
    unknown_size_repo_count INTEGER NOT NULL DEFAULT 0,
    estimated_clone_bytes INTEGER NOT NULL DEFAULT 0,
    estimated_peak_workspace_bytes INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    failure_reason TEXT
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_profile_analysis_one_active_run
    ON profile_repository_analysis_runs(profile_run_id)
    WHERE state IN ('queued', 'running', 'finalizing');

  CREATE INDEX IF NOT EXISTS idx_profile_analysis_runs_profile
    ON profile_repository_analysis_runs(profile_run_id, started_at DESC);

  CREATE TABLE IF NOT EXISTS profile_repository_analysis_jobs (
    id TEXT PRIMARY KEY,
    analysis_run_id TEXT NOT NULL REFERENCES profile_repository_analysis_runs(id) ON DELETE CASCADE,
    profile_repo_id INTEGER NOT NULL REFERENCES profile_repos(id) ON DELETE CASCADE,
    name_with_owner TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
    priority INTEGER NOT NULL DEFAULT 0,
    priority_reasons TEXT NOT NULL DEFAULT '[]',
    estimated_workspace_bytes INTEGER,
    attempt INTEGER NOT NULL DEFAULT 0,
    lease_owner TEXT,
    lease_expires_at TEXT,
    started_at TEXT,
    completed_at TEXT,
    failure_reason TEXT,
    UNIQUE (analysis_run_id, profile_repo_id)
  );

  CREATE INDEX IF NOT EXISTS idx_profile_analysis_jobs_claim
    ON profile_repository_analysis_jobs(state, priority DESC, estimated_workspace_bytes, id);

  CREATE TABLE IF NOT EXISTS profile_repository_analysis_results (
    id TEXT PRIMARY KEY,
    analysis_job_id TEXT NOT NULL REFERENCES profile_repository_analysis_jobs(id) ON DELETE CASCADE,
    attempt INTEGER NOT NULL,
    captured_at TEXT NOT NULL,
    source_ref_fingerprint TEXT,
    mirror_size_bytes INTEGER NOT NULL DEFAULT 0,
    git_version TEXT NOT NULL,
    git_lfs_version TEXT NOT NULL,
    git_sizer_version TEXT NOT NULL,
    metrics TEXT NOT NULL DEFAULT '{}',
    raw_artifact TEXT,
    UNIQUE (analysis_job_id, attempt)
  );

  CREATE TABLE IF NOT EXISTS profile_repository_analysis_lfs_pointers (
    analysis_result_id TEXT NOT NULL REFERENCES profile_repository_analysis_results(id) ON DELETE CASCADE,
    oid TEXT NOT NULL,
    declared_size_bytes INTEGER NOT NULL,
    representative_path TEXT NOT NULL,
    PRIMARY KEY (analysis_result_id, oid)
  );

`;

const PROFILE_RUN_COLUMNS = [
  "id",
  "source_provider",
  "source_api_url",
  "org",
  "state",
  "total_repos",
  "profiled_repos",
  "blockers",
  "warnings",
  "org_ruleset_count",
  "org_resources",
  "api_calls",
  "detail_rollup",
  "started_at",
  "completed_at",
  "failure_reason",
] as const;

function removeProfileProviderConstraint(db: Database): void {
  db.run("PRAGMA foreign_keys = OFF");
  try {
    db.transaction(() => {
      const table = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'profile_runs'")
        .get() as { sql: string } | null;
      if (!table?.sql.includes("source_provider IN")) return;

      db.run(`CREATE TABLE profile_runs_next (
        id TEXT PRIMARY KEY,
        source_provider TEXT NOT NULL DEFAULT 'github',
        source_api_url TEXT NOT NULL,
        org TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'running',
        total_repos INTEGER NOT NULL DEFAULT 0,
        profiled_repos INTEGER NOT NULL DEFAULT 0,
        blockers INTEGER NOT NULL DEFAULT 0,
        warnings INTEGER NOT NULL DEFAULT 0,
        org_ruleset_count INTEGER NOT NULL DEFAULT 0,
        org_resources TEXT NOT NULL DEFAULT '{}',
        api_calls INTEGER NOT NULL DEFAULT 0,
        detail_rollup TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        failure_reason TEXT
      )`);
      const columns = PROFILE_RUN_COLUMNS.join(", ");
      db.run(`INSERT INTO profile_runs_next (${columns}) SELECT ${columns} FROM profile_runs`);
      db.run("DROP TABLE profile_runs");
      db.run("ALTER TABLE profile_runs_next RENAME TO profile_runs");
      db.run("CREATE INDEX IF NOT EXISTS idx_profile_runs_state ON profile_runs(state)");
    })();
  } finally {
    db.run("PRAGMA foreign_keys = ON");
  }
  const violations = db.prepare("PRAGMA foreign_key_check").all();
  if (violations.length > 0) {
    throw new Error("Profile provider schema migration left invalid foreign keys");
  }
}

function backfillSourceInventoryProjects(db: Database): void {
  const rows = db
    .prepare(
      `SELECT inventories.run_id, inventories.payload,
              runs.source_provider, runs.source_api_url, runs.org
       FROM profile_source_inventories inventories
       JOIN profile_runs runs ON runs.id = inventories.run_id
       WHERE inventories.payload <> '{}'
         AND NOT EXISTS (
           SELECT 1 FROM profile_source_inventory_projects projects
           WHERE projects.run_id = inventories.run_id
         )`,
    )
    .all() as Array<{
    run_id: string;
    payload: string;
    source_provider: string;
    source_api_url: string;
    org: string;
  }>;
  if (rows.length === 0) return;

  const insertProject = db.prepare(
    `INSERT INTO profile_source_inventory_projects
       (run_id, position, source_id, path, payload)
     VALUES ($run_id, $position, $source_id, $path, $payload)`,
  );
  db.transaction(() => {
    for (const row of rows) {
      const inventory = parseSourceNamespaceInventory(JSON.parse(row.payload));
      if (
        inventory.provider !== row.source_provider ||
        inventory.sourceApiUrl !== row.source_api_url ||
        inventory.namespace !== row.org
      ) {
        throw new Error(`Legacy source inventory identity does not match run '${row.run_id}'`);
      }
      for (const [position, project] of inventory.projects.entries()) {
        insertProject.run({
          $run_id: row.run_id,
          $position: position,
          $source_id: project.sourceId,
          $path: project.path,
          $payload: JSON.stringify(project),
        });
      }
      db.prepare(
        `UPDATE profile_source_inventories
         SET payload = '{}', project_count = $project_count
         WHERE run_id = $run_id`,
      ).run({
        $run_id: row.run_id,
        $project_count: JSON.stringify(inventory.projectCount),
      });
    }
  })();
}

/**
 * On startup, fail any profiling run still marked `running` — its process was
 * killed by the restart. A profile crawl runs entirely in-process (there's no
 * external job to reconnect to, unlike a migration handed off to GitHub), so a
 * `running` run whose process is gone can never make progress. Marking it
 * failed frees the provider's capacity lane and prevents the detail page from
 * polling a run that will never settle. A new profile gets a new run ID; these
 * interrupted rows are retained as audit history rather than resumed.
 */
export function recoverInterruptedProfiles(db: Database, nowMs: number = Date.now()): void {
  const completedAt = new Date(nowMs).toISOString();
  const providers = SOURCE_PROVIDERS.map(() => "?").join(", ");
  const result = db
    .prepare(
      `UPDATE profile_runs
       SET state = 'failed',
           failure_reason = 'Server restarted during profiling',
           completed_at = ?
       WHERE state = 'running'
         AND source_provider IN (${providers})`,
    )
    .run(completedAt, ...SOURCE_PROVIDERS);
  if (result.changes > 0) {
    console.log(`[profile] Marked ${result.changes} interrupted profiling run(s) as failed`);
  }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Delete completed/failed profile runs older than the age limit or outside the
 * newest-run limit. Defaults come from `PROFILE_RETENTION_DAYS` (90) and
 * `PROFILE_RETENTION_RUNS` (500); zero disables that dimension. Repository and
 * normalized inventory rows are removed in the same transaction. Running runs
 * are never retention candidates.
 */
export function pruneProfileHistory(
  db: Database,
  options: { nowMs?: number; maxAgeDays?: number; maxRuns?: number } = {},
): number {
  const nowMs = options.nowMs ?? Date.now();
  const maxAgeDays = options.maxAgeDays ?? positiveInteger(process.env.PROFILE_RETENTION_DAYS, 90);
  const maxRuns = options.maxRuns ?? positiveInteger(process.env.PROFILE_RETENTION_RUNS, 500);
  if (maxAgeDays === 0 && maxRuns === 0) return 0;
  const cutoff = new Date(nowMs - maxAgeDays * 24 * 60 * 60_000).toISOString();
  const rows = db
    .prepare(
      `SELECT id FROM profile_runs
      WHERE state IN ('completed', 'failed')
         AND (
           ($max_age_days > 0 AND COALESCE(completed_at, started_at) < $cutoff)
           OR ($max_runs > 0 AND id NOT IN (
             SELECT id FROM profile_runs
             WHERE state IN ('completed', 'failed')
             ORDER BY COALESCE(completed_at, started_at) DESC, id DESC
             LIMIT $max_runs
           ))
         )`,
    )
    .all({ $max_age_days: maxAgeDays, $cutoff: cutoff, $max_runs: maxRuns }) as Array<{
    id: string;
  }>;
  if (rows.length === 0) return 0;

  db.transaction(() => {
    const deleteInventory = db.prepare("DELETE FROM profile_source_inventories WHERE run_id = ?");
    const deleteRepos = db.prepare("DELETE FROM profile_repos WHERE run_id = ?");
    const deleteRun = db.prepare("DELETE FROM profile_runs WHERE id = ?");
    for (const { id } of rows) {
      deleteInventory.run(id);
      deleteRepos.run(id);
      deleteRun.run(id);
    }
  })();
  return rows.length;
}

/** Profile domain store descriptor — see `$lib/server/schemas`. */
export const profileStore: DomainStore = {
  applySchema(db) {
    db.run(PROFILE_DDL);
    // Columns added after the table's first release — upgrade older databases.
    addColumnIfMissing(db, "profile_runs", "source_provider", "TEXT NOT NULL DEFAULT 'github'");
    addColumnIfMissing(db, "profile_runs", "org_ruleset_count", "INTEGER NOT NULL DEFAULT 0");
    addColumnIfMissing(db, "profile_runs", "org_resources", "TEXT NOT NULL DEFAULT '{}'");
    addColumnIfMissing(db, "profile_runs", "api_calls", "INTEGER NOT NULL DEFAULT 0");
    addColumnIfMissing(db, "profile_runs", "detail_rollup", "TEXT");
    addColumnIfMissing(
      db,
      "profile_repository_analysis_runs",
      "unknown_size_repo_count",
      "INTEGER NOT NULL DEFAULT 0",
    );
    addColumnIfMissing(
      db,
      "profile_repository_analysis_jobs",
      "priority_reasons",
      "TEXT NOT NULL DEFAULT '[]'",
    );
    addColumnIfMissing(db, "profile_source_inventories", "summary", "TEXT NOT NULL DEFAULT '{}'");
    addColumnIfMissing(
      db,
      "profile_source_inventories",
      "project_count",
      `TEXT NOT NULL DEFAULT '{"kind":"exact","value":0}'`,
    );
    removeProfileProviderConstraint(db);
    backfillSourceInventoryProjects(db);
    db.run("DROP TABLE IF EXISTS profile_run_leases");
    const columns = db.prepare("PRAGMA table_info(profile_runs)").all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === "lease_managed")) {
      db.run("ALTER TABLE profile_runs DROP COLUMN lease_managed");
    }
  },
  onInit(db) {
    recoverInterruptedProfiles(db);
    const pruned = pruneProfileHistory(db);
    if (pruned > 0) console.log(`[profile] Pruned ${pruned} retained profile run(s)`);
  },
};
