import type {
  RepositoryAnalysisDetail,
  RepositoryAnalysisJob,
  RepositoryAnalysisJobState,
  RepositoryAnalysisRun,
  RepositoryAnalysisState,
} from "$lib/profile/repository-analysis";
import {
  findingsFromGitSizerMetrics,
  normalizeGitSizerMetrics,
  requiresRepositoryAnalysis,
} from "$lib/profile/repository-analysis";
import { getDb } from "$lib/server/core/db";
import type { RepoSignals } from "../types";
import { PLANNING_COLUMNS, type PlanningRow, planningRepo } from "./repos";
import { parsePersistedRepoSignals } from "./results";

const GIB = 1024 ** 3;
const POLICY_VERSION = 1;

interface AnalysisRunRow {
  id: string;
  profile_run_id: string;
  state: string;
  policy_version: number;
  selected_repo_count: number;
  completed_repo_count: number;
  failed_repo_count: number;
  unknown_size_repo_count: number;
  estimated_clone_bytes: number;
  estimated_peak_workspace_bytes: number;
  started_at: string;
  completed_at: string | null;
  failure_reason: string | null;
}

interface AnalysisJobRow {
  id: string;
  analysis_run_id: string;
  profile_repo_id: number;
  name_with_owner: string;
  state: string;
  priority: number;
  priority_reasons: string;
  estimated_workspace_bytes: number | null;
  attempt: number;
  failure_reason: string | null;
  captured_at: string | null;
  mirror_size_bytes: number | null;
  lfs_pointer_count: number | null;
  lfs_declared_bytes: number | null;
  metrics: string | null;
}

interface ProfileRepoRow {
  id: number;
  name_with_owner: string;
  signals: string;
}

export interface RepositoryAnalysisRunDeps {
  newId(): string;
  nowMs(): number;
}

const DEFAULT_DEPS: RepositoryAnalysisRunDeps = {
  newId: () => Bun.randomUUIDv7(),
  nowMs: () => Date.now(),
};

function rowToRun(row: AnalysisRunRow): RepositoryAnalysisRun {
  return {
    id: row.id,
    profileRunId: row.profile_run_id,
    state: row.state as RepositoryAnalysisState,
    policyVersion: row.policy_version,
    selectedRepoCount: row.selected_repo_count,
    completedRepoCount: row.completed_repo_count,
    failedRepoCount: row.failed_repo_count,
    unknownSizeRepoCount: row.unknown_size_repo_count,
    estimatedCloneBytes: row.estimated_clone_bytes,
    estimatedPeakWorkspaceBytes: row.estimated_peak_workspace_bytes,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    failureReason: row.failure_reason,
  };
}

function rowToJob(row: AnalysisJobRow): RepositoryAnalysisJob {
  const gitSizerMetrics = normalizeGitSizerMetrics(JSON.parse(row.metrics ?? "{}"));
  return {
    id: row.id,
    analysisRunId: row.analysis_run_id,
    profileRepoId: row.profile_repo_id,
    nameWithOwner: row.name_with_owner,
    state: row.state as RepositoryAnalysisJobState,
    priority: row.priority,
    priorityReasons: JSON.parse(row.priority_reasons) as string[],
    estimatedWorkspaceBytes: row.estimated_workspace_bytes,
    attempt: row.attempt,
    failureReason: row.failure_reason,
    result:
      row.captured_at === null || row.mirror_size_bytes === null
        ? null
        : {
            capturedAt: row.captured_at,
            mirrorSizeBytes: row.mirror_size_bytes,
            lfsPointerCount: row.lfs_pointer_count ?? 0,
            lfsDeclaredBytes: row.lfs_declared_bytes ?? 0,
            gitSizerMetrics,
            gitSizerFindings: findingsFromGitSizerMetrics(gitSizerMetrics),
          },
  };
}

function workspaceEstimate(signals: RepoSignals): number | null {
  return signals.diskUsageKb === null ? null : signals.diskUsageKb * 1024 * 2 + GIB;
}

function priorityFor(signals: RepoSignals): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  if (signals.diskUsageKb === null) {
    score += 400;
    reasons.push("Unknown API size");
  }
  if (signals.usesLfs) {
    score += 300;
    reasons.push("LFS configuration detected");
  }
  if ((signals.diskUsageKb ?? 0) >= 5 * 1024 ** 2) {
    score += 200;
    reasons.push("API size at least 5 GiB");
  } else if ((signals.diskUsageKb ?? 0) >= 1024 ** 2) {
    score += 100;
    reasons.push("API size at least 1 GiB");
  }
  if (signals.branchesCount >= 5_000) {
    score += 100;
    reasons.push("At least 5,000 branches");
  }
  if (reasons.length === 0) reasons.push("Required non-empty repository analysis");
  return { score, reasons };
}

const RUN_COLUMNS = `id, profile_run_id, state, policy_version, selected_repo_count,
  completed_repo_count, failed_repo_count, unknown_size_repo_count, estimated_clone_bytes,
  estimated_peak_workspace_bytes, started_at, completed_at, failure_reason`;

function getSelectedRepositoryAnalysisRun(
  profileRunId: string,
  requestedId?: string,
): RepositoryAnalysisRun | null {
  const database = getDb();
  const row = requestedId
    ? (database
        .prepare(
          `SELECT ${RUN_COLUMNS} FROM profile_repository_analysis_runs
           WHERE profile_run_id = ? AND id = ?`,
        )
        .get(profileRunId, requestedId) as AnalysisRunRow | null)
    : (database
        .prepare(
          `SELECT ${RUN_COLUMNS} FROM profile_repository_analysis_runs
           WHERE profile_run_id = ?
           ORDER BY CASE WHEN state IN ('queued', 'running', 'finalizing') THEN 0 ELSE 1 END,
                    started_at DESC LIMIT 1`,
        )
        .get(profileRunId) as AnalysisRunRow | null);
  return row ? rowToRun(row) : null;
}

export function getRepositoryAnalysisDetail(
  profileRunId: string,
  requestedId?: string,
): RepositoryAnalysisDetail | null {
  const run = getSelectedRepositoryAnalysisRun(profileRunId, requestedId);
  if (!run) return null;
  const rows = getDb()
    .prepare(
      `SELECT jobs.id, jobs.analysis_run_id, jobs.profile_repo_id, jobs.name_with_owner,
              jobs.state, jobs.priority, jobs.priority_reasons, jobs.estimated_workspace_bytes,
              jobs.attempt, jobs.failure_reason, results.captured_at, results.mirror_size_bytes,
              results.metrics,
              COALESCE(lfs.pointer_count, 0) AS lfs_pointer_count,
              COALESCE(lfs.declared_bytes, 0) AS lfs_declared_bytes
       FROM profile_repository_analysis_jobs jobs
       LEFT JOIN profile_repository_analysis_results results
         ON results.analysis_job_id = jobs.id AND results.attempt = jobs.attempt
       LEFT JOIN (
         SELECT analysis_result_id, COUNT(*) AS pointer_count,
                COALESCE(SUM(declared_size_bytes), 0) AS declared_bytes
         FROM profile_repository_analysis_lfs_pointers
         GROUP BY analysis_result_id
       ) lfs ON lfs.analysis_result_id = results.id
       WHERE jobs.analysis_run_id = ?
       ORDER BY jobs.priority DESC, jobs.estimated_workspace_bytes ASC, jobs.name_with_owner ASC`,
    )
    .all(run.id) as AnalysisJobRow[];
  return { run, jobs: rows.map(rowToJob) };
}

export function findRepositoriesAwaitingAnalysis(
  profileRunId: string,
  names: readonly string[],
): string[] {
  const uniqueNames = [...new Set(names)];
  if (uniqueNames.length === 0) return [];
  const placeholders = uniqueNames.map(() => "?").join(", ");
  const rows = getDb()
    .prepare(
      `SELECT ${PLANNING_COLUMNS}
       FROM profile_repos
       WHERE run_id = ? AND name_with_owner IN (${placeholders})`,
    )
    .all(profileRunId, ...uniqueNames) as PlanningRow[];
  const jobStates = new Map(
    getRepositoryAnalysisDetail(profileRunId)?.jobs.map((job) => [job.nameWithOwner, job.state]) ??
      [],
  );
  return rows
    .map(planningRepo)
    .filter(
      (repo) =>
        requiresRepositoryAnalysis(repo) && jobStates.get(repo.nameWithOwner) !== "succeeded",
    )
    .map((repo) => repo.nameWithOwner);
}

export function startRepositoryAnalysis(
  profileRunId: string,
  deps: RepositoryAnalysisRunDeps = DEFAULT_DEPS,
): RepositoryAnalysisDetail {
  const database = getDb();
  const analysisRunId = deps.newId();
  const startedAt = new Date(deps.nowMs()).toISOString();

  return database.transaction(() => {
    const profile = database
      .prepare("SELECT state, source_provider FROM profile_runs WHERE id = ?")
      .get(profileRunId) as { state: string; source_provider: string } | null;
    if (!profile) throw new Error("Profile run not found");
    if (profile.source_provider !== "github") {
      throw new Error("Repository analysis is available only for GitHub profiles");
    }
    if (profile.state !== "completed") {
      throw new Error("Repository analysis requires a completed profile");
    }

    const active = getSelectedRepositoryAnalysisRun(profileRunId);
    if (active && ["queued", "running", "finalizing"].includes(active.state)) {
      const detail = getRepositoryAnalysisDetail(profileRunId, active.id);
      if (!detail) throw new Error("Active repository analysis could not be read");
      return detail;
    }

    const rows = database
      .prepare("SELECT id, name_with_owner, signals FROM profile_repos WHERE run_id = ?")
      .all(profileRunId) as ProfileRepoRow[];
    const selected = rows
      .map((row) => ({ ...row, parsedSignals: parsePersistedRepoSignals(row.signals) }))
      .filter(({ parsedSignals }) => !parsedSignals.isEmpty);
    if (selected.length === 0) throw new Error("Profile has no non-empty repositories to analyze");

    const estimates = selected.map(({ parsedSignals }) => workspaceEstimate(parsedSignals));
    const estimatedCloneBytes = selected.reduce(
      (total, { parsedSignals }) => total + (parsedSignals.diskUsageKb ?? 0) * 1024,
      0,
    );
    const estimatedPeakWorkspaceBytes = Math.max(0, ...estimates.map((value) => value ?? 0));
    database
      .prepare(
        `INSERT INTO profile_repository_analysis_runs
          (id, profile_run_id, state, policy_version, selected_repo_count,
           unknown_size_repo_count, estimated_clone_bytes, estimated_peak_workspace_bytes,
           started_at)
         VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        analysisRunId,
        profileRunId,
        POLICY_VERSION,
        selected.length,
        estimates.filter((value) => value === null).length,
        estimatedCloneBytes,
        estimatedPeakWorkspaceBytes,
        startedAt,
      );

    const insertJob = database.prepare(
      `INSERT INTO profile_repository_analysis_jobs
        (id, analysis_run_id, profile_repo_id, name_with_owner, priority,
         priority_reasons, estimated_workspace_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of selected) {
      const priority = priorityFor(row.parsedSignals);
      insertJob.run(
        deps.newId(),
        analysisRunId,
        row.id,
        row.name_with_owner,
        priority.score,
        JSON.stringify(priority.reasons),
        workspaceEstimate(row.parsedSignals),
      );
    }

    const detail = getRepositoryAnalysisDetail(profileRunId, analysisRunId);
    if (!detail) throw new Error("Repository analysis could not be read after creation");
    return detail;
  })();
}

export function cancelRepositoryAnalysis(profileRunId: string, analysisRunId: string): void {
  const database = getDb();
  database.transaction(() => {
    const result = database
      .prepare(
        `UPDATE profile_repository_analysis_runs
         SET state = 'cancelled', completed_at = $completed_at
         WHERE id = $id AND profile_run_id = $profile_run_id
           AND state IN ('queued', 'running', 'finalizing')`,
      )
      .run({
        $id: analysisRunId,
        $profile_run_id: profileRunId,
        $completed_at: new Date().toISOString(),
      });
    if (result.changes === 0) throw new Error("Active repository analysis not found");
    database
      .prepare(
        `UPDATE profile_repository_analysis_jobs
         SET state = 'cancelled', completed_at = $completed_at
         WHERE analysis_run_id = $id AND state IN ('queued', 'running')`,
      )
      .run({ $id: analysisRunId, $completed_at: new Date().toISOString() });
  })();
}
