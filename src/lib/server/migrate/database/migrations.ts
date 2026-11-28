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
  CAPACITY_MIGRATION_STATES,
  EXECUTING_MIGRATION_STATES,
  migrationStatesSql,
  RESTARTABLE_MIGRATION_STATES,
} from "$lib/migration-state";
import { isTargetPlatform } from "$lib/migration-target";
import { getDb } from "$lib/server/core/db";
import { assertMigrationSourceApiUrl } from "$lib/server/core/source-url";
import { assertPersistableSourceApiUrl } from "$lib/source/url";
import { getMigrationExecutor, isSourceProvider, SOURCE_PROVIDERS } from "$lib/source-provider";
import { logEntrySchema } from "../failure-log";
import {
  EVENTS_THIS_ATTEMPT_SQL,
  MANUAL_GHES_IMPORT_SQL,
  PAUSED_GITLAB_ROUTE_SQL,
  PRE_IMPORT_EXPORT_SQL,
  RECOVERABLE_CHECKPOINT_SQL,
  MIGRATION_COLS as STORED_COLS,
  UNRESOLVED_REMOTE_WORK_SQL,
} from "./columns";

export const MIGRATION_COLS = `${STORED_COLS}, owner_user_id, ${PAUSED_GITLAB_ROUTE_SQL} AS route_paused`;

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
    countsAuthoritative: z.boolean(),
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
    // Keep terminal metadata readable when supplementary log entries are malformed.
    logEntries: z.unknown().transform((value) => {
      if (!Array.isArray(value)) return [];
      return value.flatMap((item) => {
        const entry = logEntrySchema.safeParse(item);
        return entry.success ? [entry.data] : [];
      });
    }),
  })
  .strict();

const eventPayloadSchemas = {
  banner: z.object({ message: z.string() }).strict(),
  step: z
    .object({
      message: z.string(),
      executorPhase: z.string().optional(),
      confirmedInactive: z.literal(true).optional(),
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
  restart: z
    .object({ message: z.string(), previousState: z.enum(["failed", "cancelled"]) })
    .strict(),
} satisfies Record<EventType, z.ZodType>;

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

  if (typeof row.warnings_count !== "number") {
    throw new Error(`Invalid migration row ${id}: invalid warnings_count`);
  }
  return {
    id,
    ...(typeof row.owner_user_id === "string" && { ownerUserId: row.owner_user_id }),
    batchId: typeof row.batch_id === "string" ? row.batch_id : null,
    githubMigrationId: typeof row.github_migration_id === "string" ? row.github_migration_id : null,
    sourceProvider,
    sourceApiUrl,
    targetProfileId,
    targetPlatform,
    targetApiUrl,
    ...(row.route_paused === 1 && { routeExecutionPaused: true as const }),
    sourceOrg,
    sourceRepo,
    targetOrg,
    targetRepo,
    state: state as MigrationState,
    failureReason: typeof row.failure_reason === "string" ? row.failure_reason : null,
    migrationLogUrl: typeof row.migration_log_url === "string" ? row.migration_log_url : null,
    warningsCount: row.warnings_count,
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

type StoredRow = Record<string, unknown>;

function* readableMigrations(rows: Iterable<StoredRow>, onUnreadable?: (id: string) => void) {
  for (const row of rows) {
    let migration: Migration;
    try {
      migration = rowToMigration(row);
    } catch {
      onUnreadable?.(row.id as string);
      continue;
    }
    yield migration;
  }
}

export function rowsToMigrations(
  rows: Iterable<StoredRow>,
  onUnreadable?: (id: string) => void,
): Migration[] {
  return Array.from(readableMigrations(rows, onUnreadable));
}

export function paginateMigrationRows(
  rows: Iterable<StoredRow>,
  { page, limit }: PaginationParams,
): PaginatedResult<Migration> {
  const offset = (page - 1) * limit;
  const data: Migration[] = [];
  let total = 0;
  for (const migration of readableMigrations(rows)) {
    if (total >= offset && data.length < limit) data.push(migration);
    total++;
  }
  return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export function insertMigration(migration: Migration): void {
  assertMigrationSourceApiUrl(migration.sourceApiUrl, migration.sourceProvider);
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
					auth_mode, request_options, owner_user_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        migration.ownerUserId ?? null,
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
    targetCounts?: Counts | null;
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
				target_counts = CASE WHEN $set_target_counts THEN $target_counts ELSE target_counts END,
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
      $set_target_counts: extra?.targetCounts !== undefined ? 1 : 0,
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

export function getResumableSourceExportId(id: string): string | null {
  return (
    getDb()
      .query<{ source_export_id: string }, [string]>(
        `SELECT source_export_id FROM migrations WHERE id = ? AND ${PRE_IMPORT_EXPORT_SQL}`,
      )
      .get(id)?.source_export_id ?? null
  );
}

export function hasUnresolvedRemoteWork(id: string): boolean {
  return !!getDb()
    .query(`SELECT 1 FROM migrations WHERE id = ? AND ${UNRESOLVED_REMOTE_WORK_SQL}`)
    .get(id);
}

export function updateMigrationSourceSize(id: string, sizeKb: number): void {
  getDb()
    .prepare("UPDATE migrations SET source_size_kb = $source_size_kb WHERE id = $id")
    .run({ $id: id, $source_size_kb: sizeKb });
}

// Quarantine only the selected attempt. The job, checkpoints and original
// unreadable data remain available for inspection.
function readDispatchCandidate(row: StoredRow): Migration | null {
  try {
    return rowToMigration(row);
  } catch {
    getDb()
      .query(`UPDATE migrations
      SET state = CASE WHEN state != 'queued' OR ${UNRESOLVED_REMOTE_WORK_SQL}
            THEN 'reconciliation_required' ELSE 'failed' END,
          failure_reason = 'Stored migration data is unreadable', completed_at = ?
      WHERE rowid = ? AND state = ? AND started_at IS ?`)
      .run(
        new Date().toISOString(),
        row.record_id as number,
        row.state as string,
        row.started_at as string,
      );
    return null;
  }
}

export function getRecoverableMigrations(): Migration[] {
  const rows = getDb()
    .prepare(
      `SELECT rowid AS record_id, ${MIGRATION_COLS} FROM migrations
			 WHERE state IN (${migrationStatesSql(EXECUTING_MIGRATION_STATES)})
				 AND auth_mode IN ('env-app', 'env-pat')
				 AND ${RECOVERABLE_CHECKPOINT_SQL}
				 AND id NOT LIKE 'seed-%'
			 ORDER BY started_at ASC`,
    )
    .all() as Record<string, unknown>[];
  return rows.map(readDispatchCandidate).filter((migration) => migration !== null);
}

export function getQueuedEnvMigrations(): Migration[] {
  const rows = getDb()
    .prepare(
      `SELECT rowid AS record_id, ${MIGRATION_COLS} FROM migrations
			 WHERE state = 'queued'
				 AND auth_mode IN ('env-app', 'env-pat')
				 AND id NOT LIKE 'seed-%'
			 ORDER BY started_at ASC`,
    )
    .all() as Record<string, unknown>[];
  return rows.map(readDispatchCandidate).filter((migration) => migration !== null);
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

export function getOwnedMigration(ownerUserId: string, id: string): Migration | null {
  const row = getDb()
    .query<Record<string, unknown>, [string, string]>(
      `SELECT ${MIGRATION_COLS} FROM migrations WHERE owner_user_id = ? AND id = ?`,
    )
    .get(ownerUserId, id);
  return row ? rowToMigration(row) : null;
}

export function listMigrationsPaginated(params: PaginationParams): PaginatedResult<Migration> {
  return paginateMigrationRows(
    getDb()
      .query<StoredRow, []>(
        `SELECT ${MIGRATION_COLS} FROM migrations WHERE source_provider IN (${EXECUTABLE_PROVIDER_SQL})
     ORDER BY started_at DESC, id DESC`,
      )
      .iterate(),
    params,
  );
}

export function searchMigrationsPaginated(
  params: PaginationParams & { q: string },
): PaginatedResult<Migration> {
  return paginateMigrationRows(
    getDb()
      .query<StoredRow, { $q: string }>(
        `SELECT ${MIGRATION_COLS} FROM migrations WHERE source_provider IN (${EXECUTABLE_PROVIDER_SQL})
     AND ${SEARCH_MATCH_CLAUSE} ORDER BY started_at DESC, id DESC`,
      )
      .iterate({ $q: likePattern(params.q) }),
    params,
  );
}

const UNRECONCILED_GHES_IMPORT = `SELECT m.id FROM migrations m
  JOIN ghes_import_jobs job ON job.migration_id = m.id
  WHERE m.state = 'reconciliation_required'
    AND (job.phase IN ('mapping', 'importing', 'auditing', 'unlocking')
      OR (job.ghes_import_id IS NULL AND job.phase = 'preparing'))`;

export function ghesQueueBlockers(
  migration: Pick<Migration, "targetPlatform" | "state">,
): string[] {
  if (migration.targetPlatform !== "ghes" || migration.state !== "queued") return [];
  return getDb()
    .query<{ id: string }, []>(UNRECONCILED_GHES_IMPORT)
    .all()
    .map((row) => row.id);
}

export function hasUnreconciledGhesImport(id?: string): boolean {
  if (id === undefined) return !!getDb().prepare(`${UNRECONCILED_GHES_IMPORT} LIMIT 1`).get();
  return !!getDb().prepare(`${UNRECONCILED_GHES_IMPORT} AND m.id = ? LIMIT 1`).get(id);
}

export function isGhesSlotHeld(): boolean {
  return !!getDb()
    .prepare(`SELECT 1 FROM migrations WHERE target_platform = 'ghes'
        AND state IN (${migrationStatesSql(CAPACITY_MIGRATION_STATES)})
      UNION ALL ${UNRECONCILED_GHES_IMPORT} LIMIT 1`)
    .get();
}

// resetMigration refreshes started_at. Use the durable restart event rather than FIFO
// to keep untouched siblings behind a failed row that is itself waiting for a slot.
const RETRYING_FAILURE = `(SELECT CASE WHEN json_valid(e.payload)
    THEN json_extract(e.payload, '$.previousState') = 'failed' END
    FROM events e WHERE e.migration_id = migrations.id AND e.event_type = 'restart'
    ORDER BY e.id DESC LIMIT 1)`;

export function requiresManualImportReview(id: string): boolean {
  return !!getDb()
    .prepare(`SELECT 1 FROM migrations WHERE id = ? AND ${MANUAL_GHES_IMPORT_SQL}`)
    .get(id);
}

// Confirmation releases the batch only for an attempt that cannot be restarted.
const HAS_INACTIVE_CONFIRMATION = `EXISTS (
    SELECT 1 FROM events e WHERE ${EVENTS_THIS_ATTEMPT_SQL}
    AND CASE WHEN json_valid(e.payload) THEN json_type(e.payload, '$.confirmedInactive') = 'true' END)`;

const BLOCKS_BATCH = `(state = 'reconciliation_required' OR (state = 'failed' AND NOT (
  ${MANUAL_GHES_IMPORT_SQL} AND ${HAS_INACTIVE_CONFIRMATION})))`;

export function markMigrationReviewed(id: string): boolean {
  return (
    getDb()
      .prepare(`UPDATE migrations SET state = 'failed' WHERE id = ? AND (
      state = 'reconciliation_required' OR (
        state = 'failed' AND source_provider = 'bitbucket-server' AND ${MANUAL_GHES_IMPORT_SQL}
        AND NOT ${HAS_INACTIVE_CONFIRMATION}
      ))`)
      .run(id).changes === 1
  );
}

export function isBatchAdmissionBlocked(
  migration: Pick<Migration, "id" | "batchId" | "sourceProvider" | "targetPlatform" | "state">,
): boolean {
  if (
    migration.batchId === null ||
    migration.sourceProvider !== "bitbucket-server" ||
    migration.targetPlatform !== "ghes"
  )
    return false;
  return !!getDb()
    .prepare(`SELECT 1 FROM migrations WHERE batch_id = $batch AND id != $id
    AND (${BLOCKS_BATCH} OR (state = 'queued' AND NOT $retry AND ${RETRYING_FAILURE})) LIMIT 1`)
    .get({
      $batch: migration.batchId,
      $id: migration.id,
      $retry: Number(migration.state === "failed"),
    });
}

export function getNextQueuedMigration(
  skipGhes = false,
): { migration: Migration | null; id: string } | null {
  const row = getDb()
    .prepare(
      `WITH retries AS MATERIALIZED (
         SELECT id, batch_id FROM migrations WHERE batch_id IS NOT NULL AND state = 'queued'
           AND ${RETRYING_FAILURE}
       )
       SELECT rowid AS record_id, ${MIGRATION_COLS} FROM migrations
			 WHERE state = 'queued' AND source_provider IN (${EXECUTABLE_PROVIDER_SQL})
			 ${skipGhes ? "AND target_platform != 'ghes'" : ""}
			 AND NOT (batch_id IS NOT NULL AND source_provider = 'bitbucket-server'
			   AND target_platform = 'ghes'
			   AND (batch_id IN (SELECT batch_id FROM migrations WHERE batch_id IS NOT NULL AND ${BLOCKS_BATCH})
			     OR (batch_id IN (SELECT batch_id FROM retries) AND id NOT IN (SELECT id FROM retries))))
			 ORDER BY started_at ASC, id ASC LIMIT 1`,
    )
    .get() as Record<string, unknown> | undefined;
  return row ? { id: row.id as string, migration: readDispatchCandidate(row) } : null;
}
