import type {
  BatchListItem,
  BatchSummary,
  Migration,
  PaginatedResult,
  PaginationParams,
} from "$lib/migrate/types";
import { isTargetPlatform } from "$lib/migration-target";
import { getDb } from "$lib/server/core/db";
import { isSourceProvider } from "$lib/source-provider";
import {
  EXECUTABLE_PROVIDER_SQL,
  likePattern,
  MIGRATION_COLS,
  rowsToMigrations,
  SEARCH_MATCH_CLAUSE,
} from "./migrations";

const BATCH_AGG_COLS = `
	batch_id,
	COUNT(*) AS total,
	SUM(CASE WHEN state = 'queued' THEN 1 ELSE 0 END) AS queued,
	SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS pending,
	SUM(CASE WHEN state = 'running' THEN 1 ELSE 0 END) AS running,
	SUM(CASE WHEN state = 'cancelling' THEN 1 ELSE 0 END) AS cancelling,
	SUM(CASE WHEN state = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
	SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failed,
	SUM(CASE WHEN state = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
	SUM(CASE WHEN state = 'reconciliation_required' THEN 1 ELSE 0 END) AS reconciliation_required,
	MIN(started_at) AS started_at,
	MIN(source_provider) AS source_provider,
	MIN(source_api_url) AS source_api_url,
	MIN(target_platform) AS target_platform,
	COUNT(DISTINCT source_provider || '|' || source_api_url || '|' || target_platform) AS route_count`;

function rowToBatchListItem(row: Record<string, unknown>): BatchListItem {
  if (!isSourceProvider(row.source_provider)) {
    throw new Error(`Invalid batch row ${String(row.batch_id)}: invalid source provider`);
  }
  if (typeof row.source_api_url !== "string" || !isTargetPlatform(row.target_platform)) {
    throw new Error(`Invalid batch row ${String(row.batch_id)}: invalid migration path`);
  }
  return {
    id: row.batch_id as string,
    sourceProvider: row.source_provider,
    sourceApiUrl: row.source_api_url,
    targetPlatform: row.target_platform,
    mixedRoute: (row.route_count as number) > 1,
    totalCount: row.total as number,
    queuedCount: row.queued as number,
    pendingCount: row.pending as number,
    runningCount: row.running as number,
    cancellingCount: row.cancelling as number,
    succeededCount: row.succeeded as number,
    failedCount: row.failed as number,
    cancelledCount: row.cancelled as number,
    reconciliationRequiredCount: row.reconciliation_required as number,
    startedAt: row.started_at as string,
  };
}

export function getBatchMigrations(batchId: string): Migration[] {
  const rows = getDb()
    .prepare(
      `SELECT ${MIGRATION_COLS} FROM migrations
			 WHERE batch_id = ? AND source_provider IN (${EXECUTABLE_PROVIDER_SQL})
			 ORDER BY source_repo ASC`,
    )
    .all(batchId) as Record<string, unknown>[];
  return rowsToMigrations(rows);
}

export function getBatchSourceProviderValues(batchId: string): string[] {
  const rows = getDb()
    .prepare("SELECT DISTINCT source_provider FROM migrations WHERE batch_id = ?")
    .all(batchId) as Array<{ source_provider: string }>;
  return rows.map((row) => row.source_provider);
}

export function getRestartableBatchSourceProviderValues(batchId: string): string[] {
  const rows = getDb()
    .prepare(
      "SELECT DISTINCT source_provider FROM migrations WHERE batch_id = ? AND state IN ('failed', 'cancelled')",
    )
    .all(batchId) as Array<{ source_provider: string }>;
  return rows.map((row) => row.source_provider);
}

export function getBatchMigrationsPaginated(
  batchId: string,
  params: PaginationParams,
): PaginatedResult<Migration> {
  const { page, limit } = params;
  const offset = (page - 1) * limit;
  const { count: total } = getDb()
    .prepare(
      `SELECT COUNT(*) AS count FROM migrations
			 WHERE batch_id = ? AND source_provider IN (${EXECUTABLE_PROVIDER_SQL})`,
    )
    .get(batchId) as { count: number };
  const rows = getDb()
    .prepare(
      `SELECT ${MIGRATION_COLS} FROM migrations
			 WHERE batch_id = ? AND source_provider IN (${EXECUTABLE_PROVIDER_SQL})
			 ORDER BY source_repo ASC LIMIT ? OFFSET ?`,
    )
    .all(batchId, limit, offset) as Record<string, unknown>[];
  return {
    data: rowsToMigrations(rows),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

export function getBatchSummary(batchId: string): BatchSummary | null {
  const item = getBatchListItem(batchId);
  if (!item) return null;
  return { ...item, migrations: getBatchMigrations(batchId) };
}

export function getBatchListItem(batchId: string): BatchListItem | null {
  const row = getDb()
    .prepare(
      `SELECT ${BATCH_AGG_COLS}
			 FROM migrations
			 WHERE batch_id = ? AND source_provider IN (${EXECUTABLE_PROVIDER_SQL})
			 GROUP BY batch_id`,
    )
    .get(batchId) as Record<string, unknown> | undefined;
  return row ? rowToBatchListItem(row) : null;
}

export function listBatchItemsPaginated(params: PaginationParams): PaginatedResult<BatchListItem> {
  const { page, limit } = params;
  const offset = (page - 1) * limit;
  const { count: total } = getDb()
    .prepare(
      `SELECT COUNT(DISTINCT batch_id) AS count FROM migrations
			 WHERE batch_id IS NOT NULL AND source_provider IN (${EXECUTABLE_PROVIDER_SQL})`,
    )
    .get() as { count: number };
  const rows = getDb()
    .prepare(
      `SELECT ${BATCH_AGG_COLS}
			 FROM migrations
			 WHERE batch_id IS NOT NULL AND source_provider IN (${EXECUTABLE_PROVIDER_SQL})
			 GROUP BY batch_id
			 ORDER BY MIN(started_at) DESC
			 LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as Record<string, unknown>[];
  return {
    data: rows.map(rowToBatchListItem),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

export function searchBatchItemsPaginated(
  params: PaginationParams & { q: string },
): PaginatedResult<BatchListItem> {
  const { page, limit, q } = params;
  const offset = (page - 1) * limit;
  const like = likePattern(q);
  const matchingBatchIds = `
		SELECT DISTINCT batch_id FROM migrations
		WHERE batch_id IS NOT NULL
			AND source_provider IN (${EXECUTABLE_PROVIDER_SQL})
			AND ${SEARCH_MATCH_CLAUSE}`;
  const { count: total } = getDb()
    .prepare(`SELECT COUNT(*) AS count FROM (${matchingBatchIds})`)
    .get({ $q: like }) as { count: number };
  const rows = getDb()
    .prepare(
      `SELECT ${BATCH_AGG_COLS}
			 FROM migrations
			 WHERE batch_id IN (${matchingBatchIds})
				 AND source_provider IN (${EXECUTABLE_PROVIDER_SQL})
			 GROUP BY batch_id
			 ORDER BY MIN(started_at) DESC
			 LIMIT $limit OFFSET $offset`,
    )
    .all({ $q: like, $limit: limit, $offset: offset }) as Record<string, unknown>[];
  return {
    data: rows.map(rowToBatchListItem),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}
