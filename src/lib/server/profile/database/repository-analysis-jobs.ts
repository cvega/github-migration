import { getDb } from "$lib/server/core/db";

export interface ClaimedRepositoryAnalysisJob {
  id: string;
  analysisRunId: string;
  profileRunId: string;
  profileRepoId: number;
  nameWithOwner: string;
  sourceApiUrl: string;
  attempt: number;
  estimatedWorkspaceBytes: number | null;
}

export interface RepositoryAnalysisResultInput {
  sourceRefFingerprint: string;
  mirrorSizeBytes: number;
  gitVersion: string;
  gitLfsVersion: string;
  gitSizerVersion: string;
  metrics: unknown;
  rawArtifact?: string;
  lfsPointers: Array<{ oid: string; declaredSizeBytes: number; representativePath: string }>;
}

interface ClaimRow {
  id: string;
  analysis_run_id: string;
  profile_run_id: string;
  profile_repo_id: number;
  name_with_owner: string;
  source_api_url: string;
  attempt: number;
  estimated_workspace_bytes: number | null;
}

function finalizeIfTerminal(analysisRunId: string, completedAt: string): void {
  const database = getDb();
  database
    .prepare(
      `UPDATE profile_repository_analysis_runs
       SET completed_repo_count = (
             SELECT COUNT(*) FROM profile_repository_analysis_jobs
             WHERE analysis_run_id = $id AND state = 'succeeded'
           ),
           failed_repo_count = (
             SELECT COUNT(*) FROM profile_repository_analysis_jobs
             WHERE analysis_run_id = $id AND state = 'failed'
           ),
           state = CASE WHEN NOT EXISTS (
             SELECT 1 FROM profile_repository_analysis_jobs
             WHERE analysis_run_id = $id AND state IN ('queued', 'running')
           ) THEN 'completed' ELSE state END,
           completed_at = CASE WHEN NOT EXISTS (
             SELECT 1 FROM profile_repository_analysis_jobs
             WHERE analysis_run_id = $id AND state IN ('queued', 'running')
           ) THEN $completed_at ELSE completed_at END
       WHERE id = $id AND state IN ('queued', 'running', 'finalizing')`,
    )
    .run({ $id: analysisRunId, $completed_at: completedAt });
}

export function claimRepositoryAnalysisJob(input: {
  leaseOwner: string;
  nowMs?: number;
  leaseMs?: number;
}): ClaimedRepositoryAnalysisJob | null {
  const database = getDb();
  const nowMs = input.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const leaseExpiresAt = new Date(nowMs + (input.leaseMs ?? 60_000)).toISOString();
  return database.transaction(() => {
    database
      .prepare(
        `UPDATE profile_repository_analysis_jobs
         SET state = 'queued', lease_owner = NULL, lease_expires_at = NULL,
             failure_reason = 'Previous worker lease expired'
         WHERE state = 'running' AND lease_expires_at < ?`,
      )
      .run(now);
    const row = database
      .prepare(
        `SELECT jobs.id, jobs.analysis_run_id, runs.profile_run_id, jobs.profile_repo_id,
                jobs.name_with_owner, profiles.source_api_url, jobs.attempt,
                jobs.estimated_workspace_bytes
         FROM profile_repository_analysis_jobs jobs
         JOIN profile_repository_analysis_runs runs ON runs.id = jobs.analysis_run_id
         JOIN profile_runs profiles ON profiles.id = runs.profile_run_id
         WHERE jobs.state = 'queued' AND runs.state IN ('queued', 'running')
         ORDER BY jobs.priority DESC, jobs.estimated_workspace_bytes ASC, jobs.id ASC
         LIMIT 1`,
      )
      .get() as ClaimRow | null;
    if (!row) return null;
    const result = database
      .prepare(
        `UPDATE profile_repository_analysis_jobs
         SET state = 'running', attempt = attempt + 1, lease_owner = ?,
             lease_expires_at = ?, started_at = ?, completed_at = NULL, failure_reason = NULL
         WHERE id = ? AND state = 'queued'`,
      )
      .run(input.leaseOwner, leaseExpiresAt, now, row.id);
    if (result.changes === 0) return null;
    database
      .prepare(
        `UPDATE profile_repository_analysis_runs SET state = 'running'
         WHERE id = ? AND state = 'queued'`,
      )
      .run(row.analysis_run_id);
    return {
      id: row.id,
      analysisRunId: row.analysis_run_id,
      profileRunId: row.profile_run_id,
      profileRepoId: row.profile_repo_id,
      nameWithOwner: row.name_with_owner,
      sourceApiUrl: row.source_api_url,
      attempt: row.attempt + 1,
      estimatedWorkspaceBytes: row.estimated_workspace_bytes,
    };
  })();
}

export function renewRepositoryAnalysisJobLease(input: {
  jobId: string;
  leaseOwner: string;
  nowMs?: number;
  leaseMs?: number;
}): boolean {
  const nowMs = input.nowMs ?? Date.now();
  const result = getDb()
    .prepare(
      `UPDATE profile_repository_analysis_jobs SET lease_expires_at = $expires
       WHERE id = $id AND state = 'running' AND lease_owner = $owner`,
    )
    .run({
      $id: input.jobId,
      $owner: input.leaseOwner,
      $expires: new Date(nowMs + (input.leaseMs ?? 60_000)).toISOString(),
    });
  return result.changes === 1;
}

export function retryRepositoryAnalysisJob(input: {
  profileRunId: string;
  analysisRunId: string;
  jobId: string;
}): void {
  const database = getDb();
  database.transaction(() => {
    const job = database
      .prepare(
        `SELECT jobs.state AS job_state, runs.state AS run_state
         FROM profile_repository_analysis_jobs jobs
         JOIN profile_repository_analysis_runs runs ON runs.id = jobs.analysis_run_id
         WHERE jobs.id = ? AND jobs.analysis_run_id = ? AND runs.profile_run_id = ?`,
      )
      .get(input.jobId, input.analysisRunId, input.profileRunId) as {
      job_state: string;
      run_state: string;
    } | null;
    if (!job) throw new Error("Repository analysis job not found");
    if (job.job_state !== "failed" && job.job_state !== "cancelled") {
      throw new Error("Only a failed or cancelled repository analysis job can be retried");
    }
    if (
      job.run_state !== "completed" &&
      job.run_state !== "failed" &&
      job.run_state !== "cancelled"
    ) {
      throw new Error("Repository analysis run is not ready for retry");
    }
    const otherActiveRun = database
      .prepare(
        `SELECT 1 FROM profile_repository_analysis_runs
         WHERE profile_run_id = ? AND id <> ?
           AND state IN ('queued', 'running', 'finalizing')`,
      )
      .get(input.profileRunId, input.analysisRunId);
    if (otherActiveRun) throw new Error("Another repository analysis run is already active");

    database
      .prepare(
        `UPDATE profile_repository_analysis_jobs
         SET state = 'queued', failure_reason = NULL, completed_at = NULL,
             lease_owner = NULL, lease_expires_at = NULL
         WHERE id = ?`,
      )
      .run(input.jobId);
    database
      .prepare(
        `UPDATE profile_repository_analysis_runs
         SET state = 'queued', completed_at = NULL, failure_reason = NULL,
             completed_repo_count = (
               SELECT COUNT(*) FROM profile_repository_analysis_jobs
               WHERE analysis_run_id = $id AND state = 'succeeded'
             ),
             failed_repo_count = (
               SELECT COUNT(*) FROM profile_repository_analysis_jobs
               WHERE analysis_run_id = $id AND state = 'failed'
             )
         WHERE id = $id`,
      )
      .run({ $id: input.analysisRunId });
  })();
}

export function completeRepositoryAnalysisJob(input: {
  job: ClaimedRepositoryAnalysisJob;
  leaseOwner: string;
  resultId: string;
  result: RepositoryAnalysisResultInput;
  nowMs?: number;
}): void {
  const database = getDb();
  const capturedAt = new Date(input.nowMs ?? Date.now()).toISOString();
  database.transaction(() => {
    const active = database
      .prepare(
        `SELECT 1 FROM profile_repository_analysis_jobs
         WHERE id = ? AND state = 'running' AND lease_owner = ?`,
      )
      .get(input.job.id, input.leaseOwner);
    if (!active) throw new Error("Repository analysis job lease is no longer active");
    database
      .prepare(
        `INSERT INTO profile_repository_analysis_results
          (id, analysis_job_id, attempt, captured_at, source_ref_fingerprint,
           mirror_size_bytes, git_version, git_lfs_version, git_sizer_version,
           metrics, raw_artifact)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.resultId,
        input.job.id,
        input.job.attempt,
        capturedAt,
        input.result.sourceRefFingerprint,
        input.result.mirrorSizeBytes,
        input.result.gitVersion,
        input.result.gitLfsVersion,
        input.result.gitSizerVersion,
        JSON.stringify(input.result.metrics),
        input.result.rawArtifact ?? null,
      );
    const insertPointer = database.prepare(
      `INSERT INTO profile_repository_analysis_lfs_pointers
        (analysis_result_id, oid, declared_size_bytes, representative_path)
       VALUES (?, ?, ?, ?)`,
    );
    for (const pointer of input.result.lfsPointers) {
      insertPointer.run(
        input.resultId,
        pointer.oid,
        pointer.declaredSizeBytes,
        pointer.representativePath,
      );
    }
    database
      .prepare(
        `UPDATE profile_repository_analysis_jobs
         SET state = 'succeeded', completed_at = ?, lease_owner = NULL, lease_expires_at = NULL
         WHERE id = ?`,
      )
      .run(capturedAt, input.job.id);
    finalizeIfTerminal(input.job.analysisRunId, capturedAt);
  })();
}

export function failRepositoryAnalysisJob(input: {
  job: ClaimedRepositoryAnalysisJob;
  leaseOwner: string;
  reason: string;
  nowMs?: number;
}): void {
  const database = getDb();
  const completedAt = new Date(input.nowMs ?? Date.now()).toISOString();
  database.transaction(() => {
    const result = database
      .prepare(
        `UPDATE profile_repository_analysis_jobs
         SET state = 'failed', completed_at = $completed_at, failure_reason = $reason,
             lease_owner = NULL, lease_expires_at = NULL
         WHERE id = $id AND state = 'running' AND lease_owner = $owner`,
      )
      .run({
        $id: input.job.id,
        $owner: input.leaseOwner,
        $reason: input.reason.slice(0, 2_000),
        $completed_at: completedAt,
      });
    if (result.changes === 0) throw new Error("Repository analysis job lease is no longer active");
    finalizeIfTerminal(input.job.analysisRunId, completedAt);
  })();
}
