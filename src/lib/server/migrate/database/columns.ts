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

/** A legacy checkpoint or serialized target can contradict the migrated column defaults. */
export const PAUSED_GITLAB_ROUTE_SQL = `(source_provider = 'gitlab' AND (
  target_platform != 'ghec' OR target_profile_id != 'ghec' OR target_api_url != 'https://api.github.com'
  OR CASE WHEN json_valid(request_options)
    THEN COALESCE(json_extract(request_options, '$.targetProfileId'), 'ghec') != 'ghec' ELSE 0 END
  OR EXISTS (SELECT 1 FROM ghes_import_jobs WHERE migration_id = migrations.id)
))`;
