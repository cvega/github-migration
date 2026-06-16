/**
 * Persistence for the Profile workspace — profiling runs and their per-repo
 * results. Uses the shared SQLite connection from `store.ts`; the `profile_*`
 * table DDL lives in `schema.ts` (applied at init alongside the migration
 * tables).
 *
 * Run aggregates (`profiledRepos`, `blockers`, `warnings`) are recomputed from
 * `profile_repos` at completion rather than incremented per repo, so they stay
 * correct even when a resumed run re-records a repository (the per-repo write is
 * an idempotent upsert keyed on `UNIQUE(run_id, name_with_owner)`).
 */
import { getDb } from "$lib/server/core/db";
import type { RepoProfile } from "./analyze";
import {
  type EnterpriseRun,
  type OrgResources,
  type ProfileRun,
  type ProfileRunState,
  type RepoSignals,
  type StoredFinding,
  type StoredRepoProfile,
  ZERO_ORG_RESOURCES,
} from "./types";

/** Raw `profile_runs` row shape. */
interface ProfileRunRow {
  id: string;
  source_api_url: string;
  org: string;
  enterprise_run_id: string | null;
  state: string;
  total_repos: number;
  profiled_repos: number;
  blockers: number;
  warnings: number;
  org_ruleset_count: number;
  org_resources: string;
  api_calls: number;
  started_at: string;
  completed_at: string | null;
  failure_reason: string | null;
}

/** Raw `profile_repos` row shape. */
interface ProfileRepoRow {
  name_with_owner: string;
  signals: string;
  blockers: number;
  warnings: number;
  infos: number;
  applying_considerations: string;
}

const RUN_COLS =
  "id, source_api_url, org, enterprise_run_id, state, total_repos, profiled_repos, blockers, warnings, org_ruleset_count, org_resources, api_calls, started_at, completed_at, failure_reason";

/** Parse JSON from a DB column, falling back to a default on malformed data. */
function safeParse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

function rowToRun(row: ProfileRunRow): ProfileRun {
  return {
    id: row.id,
    sourceApiUrl: row.source_api_url,
    org: row.org,
    state: row.state as ProfileRunState,
    totalRepos: row.total_repos,
    profiledRepos: row.profiled_repos,
    blockers: row.blockers,
    warnings: row.warnings,
    orgRulesetCount: row.org_ruleset_count,
    orgResources: {
      ...ZERO_ORG_RESOURCES,
      ...safeParse<Partial<OrgResources>>(row.org_resources, {}),
    },
    apiCalls: row.api_calls,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    failureReason: row.failure_reason,
    enterpriseRunId: row.enterprise_run_id,
  };
}

function rowToRepoProfile(row: ProfileRepoRow): StoredRepoProfile {
  return {
    nameWithOwner: row.name_with_owner,
    signals: safeParse<RepoSignals>(row.signals, {} as RepoSignals),
    blockers: row.blockers,
    warnings: row.warnings,
    infos: row.infos,
    applyingConsiderations: safeParse<StoredFinding[]>(row.applying_considerations, []),
  };
}

/** Create a new profiling run in the `running` state. */
export function createProfileRun(input: {
  id: string;
  sourceApiUrl: string;
  org: string;
  /** Parent enterprise run, when this org is profiled as part of one. */
  enterpriseRunId?: string;
  nowMs?: number;
}): ProfileRun {
  const startedAt = new Date(input.nowMs ?? Date.now()).toISOString();
  getDb()
    .prepare(
      `INSERT INTO profile_runs (id, source_api_url, org, enterprise_run_id, state, started_at)
       VALUES ($id, $url, $org, $enterprise_run_id, 'running', $started_at)`,
    )
    .run({
      $id: input.id,
      $url: input.sourceApiUrl,
      $org: input.org,
      $enterprise_run_id: input.enterpriseRunId ?? null,
      $started_at: startedAt,
    });
  const run = getProfileRun(input.id);
  if (!run) throw new Error(`Failed to create profile run '${input.id}'`);
  return run;
}

/** Record the org's repository total once discovery reports it. */
export function setProfileRunTotal(runId: string, total: number): void {
  getDb()
    .prepare(`UPDATE profile_runs SET total_repos = $total WHERE id = $id`)
    .run({ $total: total, $id: runId });
}

/**
 * Record how many repos have been enriched so far (the counts pass's running
 * tally). Persisted live during a run so the detail page's progress reflects
 * real work instead of sitting at 0 until completion, when {@link
 * completeProfileRun} recomputes the authoritative total.
 */
export function setProfileRunProfiled(runId: string, profiled: number): void {
  getDb()
    .prepare(`UPDATE profile_runs SET profiled_repos = $profiled WHERE id = $id`)
    .run({ $profiled: profiled, $id: runId });
}

/** Record the organization's ruleset count (gathered once per run). */
export function setProfileRunRulesets(runId: string, count: number): void {
  getDb()
    .prepare(`UPDATE profile_runs SET org_ruleset_count = $count WHERE id = $id`)
    .run({ $count: count, $id: runId });
}

/** Record the organization's resource counts (gathered once per run). */
export function setProfileRunOrgResources(runId: string, resources: OrgResources): void {
  getDb()
    .prepare(`UPDATE profile_runs SET org_resources = $json WHERE id = $id`)
    .run({ $json: JSON.stringify(resources), $id: runId });
}

/** Record the total API requests the crawl made (persisted once it settles). */
export function setProfileRunApiCalls(runId: string, count: number): void {
  getDb()
    .prepare(`UPDATE profile_runs SET api_calls = $count WHERE id = $id`)
    .run({ $count: count, $id: runId });
}

/**
 * Upsert one repository's profile into a run. Idempotent on
 * `(run_id, name_with_owner)` so a resumed crawl can safely re-record a repo.
 */
export function recordRepoProfile(
  runId: string,
  signals: RepoSignals,
  profile: RepoProfile,
  nowMs?: number,
): void {
  const applyingConsiderations: StoredFinding[] = profile.findings
    .filter((f) => f.status === "applies")
    .map((f) => ({ considerationId: f.consideration.id, evidence: f.evidence ?? "" }));

  getDb()
    .prepare(
      `INSERT INTO profile_repos
         (run_id, name_with_owner, signals, blockers, warnings, infos, applying_considerations, created_at)
       VALUES ($run_id, $name, $signals, $blockers, $warnings, $infos, $applying, $created_at)
       ON CONFLICT(run_id, name_with_owner) DO UPDATE SET
         signals = excluded.signals,
         blockers = excluded.blockers,
         warnings = excluded.warnings,
         infos = excluded.infos,
         applying_considerations = excluded.applying_considerations,
         created_at = excluded.created_at`,
    )
    .run({
      $run_id: runId,
      $name: profile.nameWithOwner,
      $signals: JSON.stringify(signals),
      $blockers: profile.summary.blockers,
      $warnings: profile.summary.warnings,
      $infos: profile.summary.infos,
      $applying: JSON.stringify(applyingConsiderations),
      $created_at: new Date(nowMs ?? Date.now()).toISOString(),
    });
}

/**
 * Mark a repo as fully enriched — it finished the final per-repo pass, so a
 * resumed run can skip it. (`recordRepoProfile` never touches this flag, so
 * re-recording a pending repo on resume keeps it pending until it's done.)
 */
export function setRepoEnriched(runId: string, nameWithOwner: string): void {
  getDb()
    .prepare(`UPDATE profile_repos SET enriched = 1 WHERE run_id = $id AND name_with_owner = $name`)
    .run({ $id: runId, $name: nameWithOwner });
}

/** The names of repos already fully enriched in a run (skip set for a resume). */
export function getEnrichedRepoNames(runId: string): Set<string> {
  const rows = getDb()
    .prepare(`SELECT name_with_owner FROM profile_repos WHERE run_id = $id AND enriched = 1`)
    .all({ $id: runId }) as Array<{ name_with_owner: string }>;
  return new Set(rows.map((r) => r.name_with_owner));
}

/**
 * Reset an interrupted run to `running` so a resume can continue it — clears the
 * terminal fields but keeps every recorded repo (and its `enriched` flag) intact.
 */
export function resetProfileRunForResume(runId: string): void {
  getDb()
    .prepare(
      `UPDATE profile_runs SET state = 'running', failure_reason = NULL, completed_at = NULL
       WHERE id = $id`,
    )
    .run({ $id: runId });
}

/**
 * Mark a run completed, recomputing its aggregates from the recorded repos so
 * the totals are authoritative regardless of how many times a repo was written.
 * `total_repos` is clamped up to the recorded count: a run can never have
 * profiled more repos than it has (e.g. a rate-limited re-discovery that came
 * back short must not leave the denominator below the numerator).
 */
export function completeProfileRun(runId: string, nowMs?: number): void {
  getDb()
    .prepare(
      `UPDATE profile_runs SET
         profiled_repos = (SELECT COUNT(*) FROM profile_repos WHERE run_id = $id),
         total_repos = MAX(total_repos, (SELECT COUNT(*) FROM profile_repos WHERE run_id = $id)),
         blockers = (SELECT COALESCE(SUM(blockers), 0) FROM profile_repos WHERE run_id = $id),
         warnings = (SELECT COALESCE(SUM(warnings), 0) FROM profile_repos WHERE run_id = $id),
         state = 'completed',
         completed_at = $completed_at
       WHERE id = $id`,
    )
    .run({ $id: runId, $completed_at: new Date(nowMs ?? Date.now()).toISOString() });
}

/** Mark a run failed with a reason (e.g. discovery threw). */
export function failProfileRun(runId: string, reason: string, nowMs?: number): void {
  getDb()
    .prepare(
      `UPDATE profile_runs SET state = 'failed', failure_reason = $reason, completed_at = $completed_at
       WHERE id = $id`,
    )
    .run({
      $id: runId,
      $reason: reason,
      $completed_at: new Date(nowMs ?? Date.now()).toISOString(),
    });
}

/**
 * Mark a run `paused` — a deliberate, non-terminal stop. Keeps every recorded
 * repo (and its `enriched` flag) so a resume continues only the unfinished work;
 * clears any failure reason and leaves `completed_at` null (the run isn't done).
 * The live `profiled_repos` tally is left as-is, reflecting work done so far.
 */
export function pauseProfileRun(runId: string): void {
  getDb()
    .prepare(
      `UPDATE profile_runs SET state = 'paused', failure_reason = NULL, completed_at = NULL
       WHERE id = $id`,
    )
    .run({ $id: runId });
}

/** Fetch a run by id, or null if it doesn't exist. */
export function getProfileRun(id: string): ProfileRun | null {
  const row = getDb()
    .prepare(`SELECT ${RUN_COLS} FROM profile_runs WHERE id = $id`)
    .get({ $id: id }) as ProfileRunRow | null;
  return row ? rowToRun(row) : null;
}

/** List standalone runs (not part of an enterprise run), most recent first. */
export function listProfileRuns(limit = 50): ProfileRun[] {
  const rows = getDb()
    .prepare(
      `SELECT ${RUN_COLS} FROM profile_runs
       WHERE enterprise_run_id IS NULL
       ORDER BY started_at DESC LIMIT $limit`,
    )
    .all({ $limit: limit }) as ProfileRunRow[];
  return rows.map(rowToRun);
}

/**
 * Standalone org runs still marked `running` — interrupted by a restart and
 * eligible for the service to resume. Excludes child runs (those are driven by
 * their enterprise run's resume).
 */
export function listStandaloneRunningProfileRuns(): ProfileRun[] {
  const rows = getDb()
    .prepare(
      `SELECT ${RUN_COLS} FROM profile_runs
       WHERE state = 'running' AND enterprise_run_id IS NULL
       ORDER BY started_at ASC`,
    )
    .all() as ProfileRunRow[];
  return rows.map(rowToRun);
}

/** All per-repo profiles for a run, ordered by repository name. */
export function getRunRepoProfiles(runId: string): StoredRepoProfile[] {
  const rows = getDb()
    .prepare(
      `SELECT name_with_owner, signals, blockers, warnings, infos, applying_considerations
       FROM profile_repos WHERE run_id = $id ORDER BY name_with_owner ASC`,
    )
    .all({ $id: runId }) as ProfileRepoRow[];
  return rows.map(rowToRepoProfile);
}

// ── Enterprise runs ─────────────────────────────────────────────────────────

/** Raw `profile_enterprise_runs` row shape. */
interface EnterpriseRunRow {
  id: string;
  source_api_url: string;
  enterprise_slug: string;
  state: string;
  total_orgs: number;
  profiled_orgs: number;
  total_repos: number;
  profiled_repos: number;
  blockers: number;
  warnings: number;
  started_at: string;
  completed_at: string | null;
  failure_reason: string | null;
}

const ENTERPRISE_COLS =
  "id, source_api_url, enterprise_slug, state, total_orgs, profiled_orgs, total_repos, profiled_repos, blockers, warnings, started_at, completed_at, failure_reason";

function rowToEnterpriseRun(row: EnterpriseRunRow): EnterpriseRun {
  return {
    id: row.id,
    sourceApiUrl: row.source_api_url,
    enterpriseSlug: row.enterprise_slug,
    state: row.state as ProfileRunState,
    totalOrgs: row.total_orgs,
    profiledOrgs: row.profiled_orgs,
    totalRepos: row.total_repos,
    profiledRepos: row.profiled_repos,
    blockers: row.blockers,
    warnings: row.warnings,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    failureReason: row.failure_reason,
  };
}

/** Create a new enterprise run in the `running` state. */
export function createEnterpriseRun(input: {
  id: string;
  sourceApiUrl: string;
  enterpriseSlug: string;
  nowMs?: number;
}): EnterpriseRun {
  const startedAt = new Date(input.nowMs ?? Date.now()).toISOString();
  getDb()
    .prepare(
      `INSERT INTO profile_enterprise_runs (id, source_api_url, enterprise_slug, state, started_at)
       VALUES ($id, $url, $slug, 'running', $started_at)`,
    )
    .run({
      $id: input.id,
      $url: input.sourceApiUrl,
      $slug: input.enterpriseSlug,
      $started_at: startedAt,
    });
  const run = getEnterpriseRun(input.id);
  if (!run) throw new Error(`Failed to create enterprise run '${input.id}'`);
  return run;
}

/** Record the enterprise's organization total once enumeration reports it. */
export function setEnterpriseRunTotalOrgs(runId: string, total: number): void {
  getDb()
    .prepare(`UPDATE profile_enterprise_runs SET total_orgs = $total WHERE id = $id`)
    .run({ $total: total, $id: runId });
}

/**
 * Recompute an enterprise run's aggregate counters from its child org runs:
 * how many have settled, and the summed repo/blocker/warning totals. Called as
 * each child completes so the enterprise view stays live.
 */
export function refreshEnterpriseRunAggregates(runId: string): void {
  getDb()
    .prepare(
      `UPDATE profile_enterprise_runs SET
         profiled_orgs = (SELECT COUNT(*) FROM profile_runs
                          WHERE enterprise_run_id = $id AND state IN ('completed', 'failed')),
         total_repos = (SELECT COALESCE(SUM(total_repos), 0) FROM profile_runs WHERE enterprise_run_id = $id),
         profiled_repos = (SELECT COALESCE(SUM(profiled_repos), 0) FROM profile_runs WHERE enterprise_run_id = $id),
         blockers = (SELECT COALESCE(SUM(blockers), 0) FROM profile_runs WHERE enterprise_run_id = $id),
         warnings = (SELECT COALESCE(SUM(warnings), 0) FROM profile_runs WHERE enterprise_run_id = $id)
       WHERE id = $id`,
    )
    .run({ $id: runId });
}

/** Mark an enterprise run completed, refreshing its aggregates first. */
export function completeEnterpriseRun(runId: string, nowMs?: number): void {
  refreshEnterpriseRunAggregates(runId);
  getDb()
    .prepare(
      `UPDATE profile_enterprise_runs SET state = 'completed', completed_at = $completed_at WHERE id = $id`,
    )
    .run({ $id: runId, $completed_at: new Date(nowMs ?? Date.now()).toISOString() });
}

/** Mark an enterprise run failed with a reason (e.g. org enumeration threw). */
export function failEnterpriseRun(runId: string, reason: string, nowMs?: number): void {
  getDb()
    .prepare(
      `UPDATE profile_enterprise_runs SET state = 'failed', failure_reason = $reason, completed_at = $completed_at
       WHERE id = $id`,
    )
    .run({
      $id: runId,
      $reason: reason,
      $completed_at: new Date(nowMs ?? Date.now()).toISOString(),
    });
}

/**
 * Mark an enterprise run `paused` — a deliberate, non-terminal stop. Refreshes
 * its aggregates first (so the roll-up reflects the children settled so far),
 * clears any failure reason, and leaves it resumable: a resume re-enumerates the
 * orgs, skips completed children, and continues the paused/unfinished ones.
 */
export function pauseEnterpriseRun(runId: string): void {
  refreshEnterpriseRunAggregates(runId);
  getDb()
    .prepare(
      `UPDATE profile_enterprise_runs SET state = 'paused', failure_reason = NULL, completed_at = NULL
       WHERE id = $id`,
    )
    .run({ $id: runId });
}

/** Fetch an enterprise run by id, or null if it doesn't exist. */
export function getEnterpriseRun(id: string): EnterpriseRun | null {
  const row = getDb()
    .prepare(`SELECT ${ENTERPRISE_COLS} FROM profile_enterprise_runs WHERE id = $id`)
    .get({ $id: id }) as EnterpriseRunRow | null;
  return row ? rowToEnterpriseRun(row) : null;
}

/** List enterprise runs, most recent first. */
export function listEnterpriseRuns(limit = 50): EnterpriseRun[] {
  const rows = getDb()
    .prepare(
      `SELECT ${ENTERPRISE_COLS} FROM profile_enterprise_runs ORDER BY started_at DESC LIMIT $limit`,
    )
    .all({ $limit: limit }) as EnterpriseRunRow[];
  return rows.map(rowToEnterpriseRun);
}

/** Enterprise runs still marked `running` — interrupted by a restart. */
export function listRunningEnterpriseRuns(): EnterpriseRun[] {
  const rows = getDb()
    .prepare(
      `SELECT ${ENTERPRISE_COLS} FROM profile_enterprise_runs
       WHERE state = 'running' ORDER BY started_at ASC`,
    )
    .all() as EnterpriseRunRow[];
  return rows.map(rowToEnterpriseRun);
}

/**
 * Reset an interrupted enterprise run to `running` so a resume can continue it —
 * clears the terminal fields but keeps its child runs (and their progress).
 */
export function resetEnterpriseRunForResume(runId: string): void {
  getDb()
    .prepare(
      `UPDATE profile_enterprise_runs SET state = 'running', failure_reason = NULL, completed_at = NULL
       WHERE id = $id`,
    )
    .run({ $id: runId });
}

/** All child org runs of an enterprise run, most recent first. */
export function getEnterpriseChildRuns(enterpriseRunId: string): ProfileRun[] {
  const rows = getDb()
    .prepare(
      `SELECT ${RUN_COLS} FROM profile_runs
       WHERE enterprise_run_id = $id ORDER BY org ASC`,
    )
    .all({ $id: enterpriseRunId }) as ProfileRunRow[];
  return rows.map(rowToRun);
}
