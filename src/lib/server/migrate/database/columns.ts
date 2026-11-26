const MIGRATION_COLUMNS = [
  "id",
  "batch_id",
  "github_migration_id",
  "source_export_id",
  "source_provider",
  "source_api_url",
  "target_profile_id",
  "target_platform",
  "target_api_url",
  "source_org",
  "source_repo",
  "target_org",
  "target_repo",
  "state",
  "failure_reason",
  "migration_log_url",
  "warnings_count",
  "source_counts",
  "target_counts",
  "started_at",
  "completed_at",
  "elapsed_seconds",
  "pipeline_step",
  "auth_mode",
  "request_options",
  "source_size_kb",
] as const;

export const MIGRATION_COLS = MIGRATION_COLUMNS.join(", ");

// Only a checkpoint *before* the target write permits restarting from a native export.
export const PRE_IMPORT_EXPORT_SQL = `(target_platform = 'ghec' AND source_provider IN ('gitlab', 'bitbucket-server')
    AND github_migration_id IS NULL
    AND source_export_id IS NOT NULL
    AND coalesce(pipeline_step, '') IN ('source_export', 'source_export_ready', 'archive_upload'))`;

export const RECOVERABLE_CHECKPOINT_SQL = `(
  github_migration_id IS NOT NULL OR ${PRE_IMPORT_EXPORT_SQL}
  OR (target_platform = 'ghes' AND EXISTS (
    SELECT 1 FROM ghes_import_jobs job WHERE job.migration_id = migrations.id
      AND job.phase NOT IN ('failed', 'cancelled', 'reconciliation_required')
      AND (job.exporter_job_id IS NOT NULL OR job.ghes_import_id IS NOT NULL)
  ))
)`;

export const UNRESOLVED_REMOTE_WORK_SQL = `(state = 'cancelling' OR github_migration_id IS NOT NULL
  OR source_export_id IS NOT NULL OR pipeline_step IN ('ghec_starting', 'source_export')
  OR EXISTS (SELECT 1 FROM ghes_import_jobs WHERE migration_id = migrations.id))`;

/** A legacy checkpoint or serialized target can contradict the migrated column defaults. */
export const PAUSED_GITLAB_ROUTE_SQL = `(source_provider = 'gitlab' AND (
  target_platform != 'ghec' OR target_profile_id != 'ghec' OR target_api_url != 'https://api.github.com'
  OR CASE WHEN json_valid(request_options)
    THEN COALESCE(json_extract(request_options, '$.targetProfileId'), 'ghec') != 'ghec' ELSE 0 END
  OR EXISTS (SELECT 1 FROM ghes_import_jobs WHERE migration_id = migrations.id)
))`;
