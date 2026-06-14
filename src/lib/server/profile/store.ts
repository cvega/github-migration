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
import { getDb } from "$lib/server/store";
import type { RepoProfile } from "./analyze";
import type {
  ProfileRun,
  ProfileRunState,
  RepoSignals,
  StoredFinding,
  StoredRepoProfile,
} from "./types";

/** Raw `profile_runs` row shape. */
interface ProfileRunRow {
  id: string;
  source_api_url: string;
  org: string;
  state: string;
  total_repos: number;
  profiled_repos: number;
  blockers: number;
  warnings: number;
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
  applying_gaps: string;
}

const RUN_COLS =
  "id, source_api_url, org, state, total_repos, profiled_repos, blockers, warnings, started_at, completed_at, failure_reason";

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
    startedAt: row.started_at,
    completedAt: row.completed_at,
    failureReason: row.failure_reason,
  };
}

function rowToRepoProfile(row: ProfileRepoRow): StoredRepoProfile {
  return {
    nameWithOwner: row.name_with_owner,
    signals: safeParse<RepoSignals>(row.signals, {} as RepoSignals),
    blockers: row.blockers,
    warnings: row.warnings,
    infos: row.infos,
    applyingGaps: safeParse<StoredFinding[]>(row.applying_gaps, []),
  };
}

/** Create a new profiling run in the `running` state. */
export function createProfileRun(input: {
  id: string;
  sourceApiUrl: string;
  org: string;
  nowMs?: number;
}): ProfileRun {
  const startedAt = new Date(input.nowMs ?? Date.now()).toISOString();
  getDb()
    .prepare(
      `INSERT INTO profile_runs (id, source_api_url, org, state, started_at)
       VALUES ($id, $url, $org, 'running', $started_at)`,
    )
    .run({ $id: input.id, $url: input.sourceApiUrl, $org: input.org, $started_at: startedAt });
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
 * Upsert one repository's profile into a run. Idempotent on
 * `(run_id, name_with_owner)` so a resumed crawl can safely re-record a repo.
 */
export function recordRepoProfile(
  runId: string,
  signals: RepoSignals,
  profile: RepoProfile,
  nowMs?: number,
): void {
  const applyingGaps: StoredFinding[] = profile.findings
    .filter((f) => f.status === "applies")
    .map((f) => ({ gapId: f.gap.id, evidence: f.evidence ?? "" }));

  getDb()
    .prepare(
      `INSERT INTO profile_repos
         (run_id, name_with_owner, signals, blockers, warnings, infos, applying_gaps, created_at)
       VALUES ($run_id, $name, $signals, $blockers, $warnings, $infos, $applying, $created_at)
       ON CONFLICT(run_id, name_with_owner) DO UPDATE SET
         signals = excluded.signals,
         blockers = excluded.blockers,
         warnings = excluded.warnings,
         infos = excluded.infos,
         applying_gaps = excluded.applying_gaps,
         created_at = excluded.created_at`,
    )
    .run({
      $run_id: runId,
      $name: profile.nameWithOwner,
      $signals: JSON.stringify(signals),
      $blockers: profile.summary.blockers,
      $warnings: profile.summary.warnings,
      $infos: profile.summary.infos,
      $applying: JSON.stringify(applyingGaps),
      $created_at: new Date(nowMs ?? Date.now()).toISOString(),
    });
}

/**
 * Mark a run completed, recomputing its aggregates from the recorded repos so
 * the totals are authoritative regardless of how many times a repo was written.
 */
export function completeProfileRun(runId: string, nowMs?: number): void {
  getDb()
    .prepare(
      `UPDATE profile_runs SET
         profiled_repos = (SELECT COUNT(*) FROM profile_repos WHERE run_id = $id),
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

/** Fetch a run by id, or null if it doesn't exist. */
export function getProfileRun(id: string): ProfileRun | null {
  const row = getDb()
    .prepare(`SELECT ${RUN_COLS} FROM profile_runs WHERE id = $id`)
    .get({ $id: id }) as ProfileRunRow | null;
  return row ? rowToRun(row) : null;
}

/** List runs, most recent first. */
export function listProfileRuns(limit = 50): ProfileRun[] {
  const rows = getDb()
    .prepare(`SELECT ${RUN_COLS} FROM profile_runs ORDER BY started_at DESC LIMIT $limit`)
    .all({ $limit: limit }) as ProfileRunRow[];
  return rows.map(rowToRun);
}

/** All per-repo profiles for a run, ordered by repository name. */
export function getRunRepoProfiles(runId: string): StoredRepoProfile[] {
  const rows = getDb()
    .prepare(
      `SELECT name_with_owner, signals, blockers, warnings, infos, applying_gaps
       FROM profile_repos WHERE run_id = $id ORDER BY name_with_owner ASC`,
    )
    .all({ $id: runId }) as ProfileRepoRow[];
  return rows.map(rowToRepoProfile);
}
