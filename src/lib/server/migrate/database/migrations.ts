import { z } from "zod";
import {
  type AuthMode,
  type Counts,
  type EventType,
  MIGRATION_PHASES,
  type Migration,
  type MigrationEvent,
  type MigrationState,
  type PaginatedResult,
  type PaginationParams,
  type PipelineStep,
} from "$lib/migrate/types";
import {
  ALL_MIGRATION_STATES,
  EXECUTING_MIGRATION_STATES,
  migrationStatesSql,
  RESTARTABLE_MIGRATION_STATES,
} from "$lib/migration-state";
import { isTargetPlatform } from "$lib/migration-target";
import { getDb } from "$lib/server/core/db";
import { assertPersistableSourceApiUrl } from "$lib/source/url";
import { getMigrationExecutor, isSourceProvider, SOURCE_PROVIDERS } from "$lib/source-provider";
import { MIGRATION_COLS } from "./columns";

export { MIGRATION_COLS } from "./columns";

const countsSchema = z
  .object({
    commits: z.number().nonnegative(),
    branches: z.number().int().nonnegative(),
    tags: z.number().int().nonnegative(),
    issues: z.number().int().nonnegative(),
    pullRequests: z.number().int().nonnegative(),
    releases: z.number().int().nonnegative(),
  })
  .strict();

const phaseSchema = z.enum(MIGRATION_PHASES);

const snapshotSchema = z
  .object({
    timestamp: z.string(),
    migrationState: z.string(),
    failureReason: z.string(),
    migrationLogUrl: z.string(),
    warningsCount: z.number().int().nonnegative(),
    repoExists: z.boolean(),
    countsAuthoritative: z.boolean().default(false),
    repoSize: z.number().nonnegative(),
    commits: z.number().nonnegative(),
    branches: z.number().int().nonnegative(),
    tags: z.number().int().nonnegative(),
    issues: z.number().int().nonnegative(),
    pullRequests: z.number().int().nonnegative(),
    releases: z.number().int().nonnegative(),
    phase: phaseSchema,
    elapsed: z.number().nonnegative(),
  })
  .strict();

const progressSchema = z
  .object({
    current: snapshotSchema,
    previous: snapshotSchema.nullable(),
    deltaCommits: z.number(),
    deltaBranches: z.number(),
    deltaTags: z.number(),
    deltaIssues: z.number(),
    deltaPRs: z.number(),
    deltaReleases: z.number(),
    deltaSize: z.number(),
    commitsPerMin: z.number(),
    issuesPerMin: z.number(),
  })
  .strict();

const failureDetailSchema = z
  .object({
    migrationId: z.string(),
    state: z.string(),
    failureReason: z.string(),
    elapsed: z.number().nonnegative(),
    logUrl: z.string(),
    logEntries: z.array(
      z
        .object({
          severity: z.string(),
          message: z.string(),
          modelName: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

const eventPayloadSchemas = {
  banner: z.object({ message: z.string() }).strict(),
  step: z
    .object({
      message: z.string(),
      counts: countsSchema.optional(),
      postTerminal: z
        .object({
          operation: z.literal("source_archive"),
          outcome: z.enum(["succeeded", "failed", "not_attempted"]),
        })
        .strict()
        .optional(),
    })
    .strict(),
  phase_change: z.object({ from: phaseSchema, to: phaseSchema }).strict(),
  milestone: z.object({ message: z.string() }).strict(),
  snapshot: z.object({ progress: progressSchema, sourceCounts: countsSchema.nullable() }).strict(),
  complete: z
    .object({
      progress: progressSchema,
      sourceCounts: countsSchema.nullable(),
      elapsed: z.number().nonnegative(),
    })
    .strict(),
  failure: z
    .object({
      error: z.string().optional(),
      progress: progressSchema.optional(),
      detail: failureDetailSchema.optional(),
    })
    .strict(),
  restart: z.object({ message: z.string() }).strict(),
} satisfies Record<EventType, z.ZodType>;

const persistedRequestOptionsSchema = z
  .object({
    sourceApiUrl: z.string().optional(),
    sourceRepo: z.string().optional(),
    targetProfileId: z.string().optional(),
    targetOrg: z.string().optional(),
    targetRepo: z.string().optional(),
    noSslVerify: z.boolean().optional(),
    skipReleases: z.boolean().optional(),
    lockSource: z.boolean().optional(),
    archiveSource: z.boolean().optional(),
    targetRepoVisibility: z.enum(["private", "public", "internal"]).optional(),
    directPassthrough: z.boolean().optional(),
  })
  .strict();

export type PersistedRequestOptions = z.infer<typeof persistedRequestOptionsSchema>;

function parseJson(json: string, description: string): unknown {
  try {
    return JSON.parse(json);
  } catch (cause) {
    throw new Error(`Invalid stored ${description}`, { cause });
  }
}

export function parsePersistedCounts(json: string, description = "migration counts"): Counts {
  const parsed = countsSchema.safeParse(parseJson(json, description));
  if (!parsed.success) throw new Error(`Invalid stored ${description}`, { cause: parsed.error });
  return parsed.data;
}

export function parsePersistedRequestOptions(json: string): PersistedRequestOptions {
  const parsed = persistedRequestOptionsSchema.safeParse(
    parseJson(json, "migration request options"),
  );
  if (!parsed.success) {
    throw new Error("Invalid stored migration request options", { cause: parsed.error });
  }
  return parsed.data;
}

export function tryParsePersistedRequestOptions(json: string): PersistedRequestOptions | null {
  try {
    return parsePersistedRequestOptions(json);
  } catch {
    return null;
  }
}

export function parsePersistedEventPayload(
  eventType: EventType,
  json: string,
): MigrationEvent["payload"] {
  const parsed = eventPayloadSchemas[eventType].safeParse(
    parseJson(json, `${eventType} migration event payload`),
  );
  if (!parsed.success) {
    throw new Error(`Invalid stored ${eventType} migration event payload`, { cause: parsed.error });
  }
  return parsed.data as MigrationEvent["payload"];
}

export const EXECUTABLE_PROVIDER_SQL = SOURCE_PROVIDERS.filter(
  (provider) => getMigrationExecutor(provider) !== null,
)
  .map((provider) => `'${provider}'`)
  .join(", ");

export const SEARCH_MATCH_CLAUSE = `(
	source_org LIKE $q ESCAPE '\\'
	OR source_repo LIKE $q ESCAPE '\\'
	OR target_org LIKE $q ESCAPE '\\'
	OR target_repo LIKE $q ESCAPE '\\'
	OR github_migration_id LIKE $q ESCAPE '\\'
	OR id LIKE $q ESCAPE '\\'
	OR failure_reason LIKE $q ESCAPE '\\'
)`;

export function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

export function rowToMigration(row: Record<string, unknown>): Migration {
  const id = row.id;
  if (typeof id !== "string") throw new Error("Invalid migration row: missing id");
  const sourceApiUrl = row.source_api_url;
  if (typeof sourceApiUrl !== "string") {
    throw new Error(`Invalid migration row ${id}: missing source_api_url`);
  }
  const sourceProvider = row.source_provider;
  if (!isSourceProvider(sourceProvider)) {
    throw new Error(`Invalid migration row ${id}: invalid source_provider`);
  }
  const targetProfileId = row.target_profile_id;
  if (typeof targetProfileId !== "string") {
    throw new Error(`Invalid migration row ${id}: missing target_profile_id`);
  }
  const targetPlatform = row.target_platform;
  if (!isTargetPlatform(targetPlatform)) {
    throw new Error(`Invalid migration row ${id}: invalid target_platform`);
  }
  const targetApiUrl = row.target_api_url;
  if (typeof targetApiUrl !== "string") {
    throw new Error(`Invalid migration row ${id}: missing target_api_url`);
  }
  const sourceOrg = row.source_org;
  const sourceRepo = row.source_repo;
  const targetOrg = row.target_org;
  const targetRepo = row.target_repo;
  if (typeof sourceOrg !== "string")
    throw new Error(`Invalid migration row ${id}: missing source_org`);
  if (typeof sourceRepo !== "string")
    throw new Error(`Invalid migration row ${id}: missing source_repo`);
  if (typeof targetOrg !== "string")
    throw new Error(`Invalid migration row ${id}: missing target_org`);
  if (typeof targetRepo !== "string")
    throw new Error(`Invalid migration row ${id}: missing target_repo`);
  const state = row.state;
  if (typeof state !== "string" || !ALL_MIGRATION_STATES.includes(state as MigrationState)) {
    throw new Error(`Invalid migration row ${id}: invalid state "${state}"`);
  }
  const validAuthModes: AuthMode[] = ["request-pat", "request-app", "env-app", "env-pat"];
  const startedAt = row.started_at;
  if (typeof startedAt !== "string") {
    throw new Error(`Invalid migration row ${id}: missing started_at`);
  }

  return {
    id,
    batchId: typeof row.batch_id === "string" ? row.batch_id : null,
    githubMigrationId: typeof row.github_migration_id === "string" ? row.github_migration_id : null,
    sourceProvider,
    sourceApiUrl,
    targetProfileId,
    targetPlatform,
    targetApiUrl,
    sourceOrg,
    sourceRepo,
    targetOrg,
    targetRepo,
    state: state as MigrationState,
    failureReason: typeof row.failure_reason === "string" ? row.failure_reason : null,
    migrationLogUrl: typeof row.migration_log_url === "string" ? row.migration_log_url : null,
    warningsCount: typeof row.warnings_count === "number" ? row.warnings_count : 0,
    sourceCounts:
      typeof row.source_counts === "string"
        ? parsePersistedCounts(row.source_counts, `migration ${id} source counts`)
        : null,
    targetCounts:
      typeof row.target_counts === "string"
        ? parsePersistedCounts(row.target_counts, `migration ${id} target counts`)
        : null,
    sourceSizeKb: typeof row.source_size_kb === "number" ? row.source_size_kb : null,
    startedAt,
    completedAt: typeof row.completed_at === "string" ? row.completed_at : null,
    elapsedSeconds: typeof row.elapsed_seconds === "number" ? row.elapsed_seconds : null,
    authMode:
      typeof row.auth_mode === "string" && validAuthModes.includes(row.auth_mode as AuthMode)
        ? (row.auth_mode as AuthMode)
        : null,
    requestOptions: typeof row.request_options === "string" ? row.request_options : null,
  };
}

export function rowsToMigrations(rows: Record<string, unknown>[]): Migration[] {
  return rows
    .filter((row) => isSourceProvider(row.source_provider))
    .map((row) => rowToMigration(row));
}

export function insertMigration(migration: Migration): void {
  assertPersistableSourceApiUrl(migration.sourceApiUrl);
  const targetProfileId = migration.targetProfileId || "ghec";
  const targetPlatform = migration.targetPlatform || "ghec";
  const targetApiUrl = migration.targetApiUrl || "https://api.github.com";
  assertPersistableSourceApiUrl(targetApiUrl);
  getDb().transaction(() => {
    getDb()
      .prepare(
        `INSERT INTO migrations (id, batch_id, github_migration_id, source_provider, source_api_url,
					target_profile_id, target_platform, target_api_url, source_org, source_repo,
					target_org, target_repo, state, started_at, source_counts, target_counts,
					auth_mode, request_options)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        migration.id,
        migration.batchId,
        migration.githubMigrationId,
        migration.sourceProvider ?? "github",
        migration.sourceApiUrl,
        targetProfileId,
        targetPlatform,
        targetApiUrl,
        migration.sourceOrg,
        migration.sourceRepo,
        migration.targetOrg,
        migration.targetRepo,
        migration.state,
        migration.startedAt,
        migration.sourceCounts ? JSON.stringify(migration.sourceCounts) : null,
        migration.targetCounts ? JSON.stringify(migration.targetCounts) : null,
        migration.authMode,
        migration.requestOptions,
      );
    if (migration.batchId) {
      getDb()
        .prepare(
          `INSERT INTO migration_batch_items
						 (batch_id, source_org, source_repo, target_repo, migration_id)
					 VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          migration.batchId,
          migration.sourceOrg,
          migration.sourceRepo,
          migration.targetRepo,
          migration.id,
        );
    }
  })();
}

export function getBatchMigrationByItem(
  batchId: string,
  sourceOrg: string,
  sourceRepo: string,
  targetRepo: string,
): Migration | null {
  const row = getDb()
    .prepare(
      `SELECT ${MIGRATION_COLS} FROM migrations
			 WHERE id = (
				 SELECT migration_id FROM migration_batch_items
				 WHERE batch_id = ? AND source_org = ? AND source_repo = ? AND target_repo = ?
			 )`,
    )
    .get(batchId, sourceOrg, sourceRepo, targetRepo) as Record<string, unknown> | null;
  return row && isSourceProvider(row.source_provider) ? rowToMigration(row) : null;
}

export function updateMigrationState(
  id: string,
  state: MigrationState,
  extra?: {
    githubMigrationId?: string;
    failureReason?: string;
    migrationLogUrl?: string;
    warningsCount?: number;
    sourceCounts?: Counts;
    targetCounts?: Counts;
    completedAt?: string;
    elapsedSeconds?: number;
  },
  preserveCancellation = false,
): boolean {
  const result = getDb()
    .prepare(
      `UPDATE migrations SET
				state = $state,
				github_migration_id = COALESCE($github_migration_id, github_migration_id),
				failure_reason = COALESCE($failure_reason, failure_reason),
				migration_log_url = COALESCE($migration_log_url, migration_log_url),
				warnings_count = COALESCE($warnings_count, warnings_count),
				source_counts = COALESCE($source_counts, source_counts),
				target_counts = COALESCE($target_counts, target_counts),
				completed_at = COALESCE($completed_at, completed_at),
				elapsed_seconds = COALESCE($elapsed_seconds, elapsed_seconds)
			 WHERE id = $id AND ($preserve_cancellation = 0 OR state <> 'cancelling')`,
    )
    .run({
      $id: id,
      $state: state,
      $github_migration_id: extra?.githubMigrationId ?? null,
      $failure_reason: extra?.failureReason ?? null,
      $migration_log_url: extra?.migrationLogUrl ?? null,
      $warnings_count: extra?.warningsCount ?? null,
      $source_counts: extra?.sourceCounts ? JSON.stringify(extra.sourceCounts) : null,
      $target_counts: extra?.targetCounts ? JSON.stringify(extra.targetCounts) : null,
      $completed_at: extra?.completedAt ?? null,
      $elapsed_seconds: extra?.elapsedSeconds ?? null,
      $preserve_cancellation: preserveCancellation ? 1 : 0,
    });
  return !(result.changes === 0 && preserveCancellation);
}

export function claimMigrationCancellation(id: string): boolean {
  const result = getDb()
    .prepare(
      `UPDATE migrations SET state = 'cancelling'
			 WHERE id = ? AND state IN (${migrationStatesSql(EXECUTING_MIGRATION_STATES)})`,
    )
    .run(id);
  return result.changes === 1;
}

export function claimQueuedMigrationCancellation(id: string): boolean {
  const result = getDb()
    .prepare(
      `UPDATE migrations SET state = 'cancelled', completed_at = $completed_at
			 WHERE id = $id AND state = 'queued'`,
    )
    .run({ $id: id, $completed_at: new Date().toISOString() });
  return result.changes === 1;
}

export function updateCheckpoint(
  id: string,
  step: PipelineStep,
  extras?: { authMode?: AuthMode; githubMigrationId?: string },
): void {
  getDb()
    .prepare(
      `UPDATE migrations SET
				pipeline_step = $step,
				auth_mode = COALESCE($auth_mode, auth_mode),
				github_migration_id = COALESCE($github_migration_id, github_migration_id)
			 WHERE id = $id`,
    )
    .run({
      $id: id,
      $step: step,
      $auth_mode: extras?.authMode ?? null,
      $github_migration_id: extras?.githubMigrationId ?? null,
    });
}

export function updateSourceExportCheckpoint(
  id: string,
  step: "source_export" | "source_export_ready",
  sourceExportId: string,
): void {
  if (!/^[1-9]\d*$/.test(sourceExportId)) {
    throw new TypeError("Bitbucket source export ID must be a positive integer");
  }
  getDb()
    .prepare(
      `UPDATE migrations SET pipeline_step = $step, source_export_id = $source_export_id
			 WHERE id = $id`,
    )
    .run({ $id: id, $step: step, $source_export_id: sourceExportId });
}

export function updateGitLabExportCheckpoint(
  id: string,
  step: "source_export" | "source_export_ready",
): void {
  getDb()
    .prepare(
      `UPDATE migrations SET pipeline_step = $step, source_export_id = 'gitlab'
			 WHERE id = $id`,
    )
    .run({ $id: id, $step: step });
}

export function getSourceExportId(id: string): string | null {
  const row = getDb().prepare("SELECT source_export_id FROM migrations WHERE id = ?").get(id) as {
    source_export_id: unknown;
  } | null;
  return row && typeof row.source_export_id === "string" ? row.source_export_id : null;
}

export function updateMigrationSourceSize(id: string, sizeKb: number): void {
  getDb()
    .prepare("UPDATE migrations SET source_size_kb = $source_size_kb WHERE id = $id")
    .run({ $id: id, $source_size_kb: sizeKb });
}

export function getRecoverableMigrations(): Migration[] {
  const rows = getDb()
    .prepare(
      `SELECT ${MIGRATION_COLS} FROM migrations
			 WHERE state IN (${migrationStatesSql(EXECUTING_MIGRATION_STATES)})
				 AND auth_mode IN ('env-app', 'env-pat')
				 AND (
					 github_migration_id IS NOT NULL
					 OR (source_provider IN ('gitlab', 'bitbucket-server') AND source_export_id IS NOT NULL)
					 OR (target_platform = 'ghes' AND EXISTS (
						 SELECT 1 FROM ghes_import_jobs job
						 WHERE job.migration_id = migrations.id
							 AND job.phase NOT IN ('succeeded', 'failed', 'cancelled', 'reconciliation_required')
							 AND (job.exporter_job_id IS NOT NULL OR job.ghes_import_id IS NOT NULL)
					 ))
				 )
				 AND id NOT LIKE 'seed-%'
			 ORDER BY started_at ASC`,
    )
    .all() as Record<string, unknown>[];
  return rowsToMigrations(rows);
}

export function getQueuedEnvMigrations(): Migration[] {
  const rows = getDb()
    .prepare(
      `SELECT ${MIGRATION_COLS} FROM migrations
			 WHERE state = 'queued'
				 AND auth_mode IN ('env-app', 'env-pat')
				 AND id NOT LIKE 'seed-%'
			 ORDER BY started_at ASC`,
    )
    .all() as Record<string, unknown>[];
  return rowsToMigrations(rows);
}

export function resetMigration(
  id: string,
  newState: "pending" | "queued",
  authMode: AuthMode,
  requestOptions: string,
): boolean {
  const now = new Date().toISOString();
  const result = getDb()
    .prepare(
      `UPDATE migrations SET
				state = ?, github_migration_id = NULL, failure_reason = NULL,
				migration_log_url = NULL, warnings_count = 0, source_counts = NULL,
				target_counts = NULL, started_at = ?, completed_at = NULL,
				elapsed_seconds = NULL, pipeline_step = NULL, source_export_id = NULL,
				auth_mode = ?, request_options = ?
			 WHERE id = ? AND state IN (${migrationStatesSql(RESTARTABLE_MIGRATION_STATES)})`,
    )
    .run(newState, now, authMode, requestOptions, id);
  return result.changes === 1;
}

export function getMigration(id: string): Migration | null {
  const row = getDb().prepare(`SELECT ${MIGRATION_COLS} FROM migrations WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row || !isSourceProvider(row.source_provider)) return null;
  return rowToMigration(row);
}

export function listMigrationsPaginated(params: PaginationParams): PaginatedResult<Migration> {
  const offset = (params.page - 1) * params.limit;
  const { count: total } = getDb()
    .prepare(
      `SELECT COUNT(*) AS count FROM migrations
			 WHERE source_provider IN (${EXECUTABLE_PROVIDER_SQL})`,
    )
    .get() as { count: number };
  const rows = getDb()
    .prepare(
      `SELECT ${MIGRATION_COLS} FROM migrations
			 WHERE source_provider IN (${EXECUTABLE_PROVIDER_SQL})
			 ORDER BY started_at DESC LIMIT ? OFFSET ?`,
    )
    .all(params.limit, offset) as Record<string, unknown>[];
  return {
    data: rowsToMigrations(rows),
    total,
    page: params.page,
    limit: params.limit,
    totalPages: Math.ceil(total / params.limit),
  };
}

export function searchMigrationsPaginated(
  params: PaginationParams & { q: string },
): PaginatedResult<Migration> {
  const offset = (params.page - 1) * params.limit;
  const like = likePattern(params.q);
  const { count: total } = getDb()
    .prepare(
      `SELECT COUNT(*) AS count FROM migrations
			 WHERE source_provider IN (${EXECUTABLE_PROVIDER_SQL}) AND ${SEARCH_MATCH_CLAUSE}`,
    )
    .get({ $q: like }) as { count: number };
  const rows = getDb()
    .prepare(
      `SELECT ${MIGRATION_COLS} FROM migrations
			 WHERE source_provider IN (${EXECUTABLE_PROVIDER_SQL}) AND ${SEARCH_MATCH_CLAUSE}
			 ORDER BY started_at DESC LIMIT $limit OFFSET $offset`,
    )
    .all({ $q: like, $limit: params.limit, $offset: offset }) as Record<string, unknown>[];
  return {
    data: rowsToMigrations(rows),
    total,
    page: params.page,
    limit: params.limit,
    totalPages: Math.ceil(total / params.limit),
  };
}

export function getNextQueuedMigration(): Migration | null {
  const row = getDb()
    .prepare(
      `SELECT ${MIGRATION_COLS} FROM migrations
			 WHERE state = 'queued' AND source_provider IN (${EXECUTABLE_PROVIDER_SQL})
			 ORDER BY started_at ASC LIMIT 1`,
    )
    .get() as Record<string, unknown> | undefined;
  return row ? rowToMigration(row) : null;
}
