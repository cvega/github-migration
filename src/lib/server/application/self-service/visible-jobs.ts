import type {
  Migration,
  MigrationState,
  PaginatedResult,
  PaginationParams,
} from "$lib/migrate/types";
import { ALL_MIGRATION_STATES } from "$lib/migration-state";
import { getDb } from "$lib/server/core/db";
import { getMigrationTargetProfile } from "$lib/server/core/targets";
import { BATCH_AGG_COLS, rowToBatchListItem } from "$lib/server/migrate/database/batches";
import { PAUSED_GITLAB_ROUTE_SQL } from "$lib/server/migrate/database/columns";
import { likePattern, rowsToMigrations } from "$lib/server/migrate/database/migrations";
import { listGrants } from "./grants";

type Row = Record<string, unknown>;
type Bindings = Record<string, string | number>;

// Materialize no provider diagnostics, owner identifiers or persisted request options
// in this read model. All counts, searches and summaries start at the same boundary.
const visible = `WITH visible AS (
  SELECT id, batch_id, source_provider, source_api_url, source_org, source_repo,
    target_profile_id, target_platform, target_api_url, target_org, target_repo,
    state, started_at, completed_at, elapsed_seconds, source_size_kb, warnings_count,
    source_counts, target_counts
  FROM migrations WHERE NOT ${PAUSED_GITLAB_ROUTE_SQL} AND EXISTS (
    SELECT 1 FROM json_each($routes) AS route
    WHERE source_provider = route.value ->> '$.sourceProvider'
      AND source_api_url = route.value ->> '$.sourceApiUrl'
      AND source_org = route.value ->> '$.namespace'
      AND target_profile_id = route.value ->> '$.targetProfileId'
      AND target_org = route.value ->> '$.targetOrg'
      AND target_api_url = route.value ->> '$.apiUrl'
      AND target_platform = route.value ->> '$.platform'
  )
)`;

function scope(userId: string) {
  return {
    $routes: JSON.stringify(
      listGrants(userId).flatMap((grant) => {
        const target = getMigrationTargetProfile(grant.targetProfileId);
        return target ? [{ ...grant, apiUrl: target.apiUrl, platform: target.platform }] : [];
      }),
    ),
  };
}

export function listVisibleJobs(userId: string) {
  return getDb()
    .query<{ id: string; state: MigrationState }, ReturnType<typeof scope>>(
      `${visible} SELECT id, state FROM visible ORDER BY started_at DESC, id DESC`,
    )
    .all(scope(userId));
}

export function getVisibleJob(userId: string, id: string): Migration | null {
  const row = getDb()
    .query<Row, Bindings>(`${visible} SELECT * FROM visible WHERE id = $id`)
    .get({ ...scope(userId), $id: id });
  return row ? (rowsToMigrations([row])[0] ?? null) : null;
}

function paginate<T>(data: T[], total: number, params: PaginationParams): PaginatedResult<T> {
  return { data, total, ...params, totalPages: Math.ceil(total / params.limit) };
}

export function visibleDashboard(
  userId: string,
  q: string,
  params: PaginationParams,
  batchPage: number,
) {
  const db = getDb();
  const bindings = scope(userId);
  const match = ` FROM visible WHERE id LIKE $q ESCAPE '\\' OR batch_id LIKE $q ESCAPE '\\'
    OR source_org LIKE $q ESCAPE '\\' OR source_repo LIKE $q ESCAPE '\\'
    OR target_org LIKE $q ESCAPE '\\' OR target_repo LIKE $q ESCAPE '\\'`;
  const query = { ...bindings, $q: likePattern(q) };
  const count = (sql: string) => db.query<{ n: number }, typeof query>(sql).get(query)!.n;
  const migrations = paginate(
    rowsToMigrations(
      db
        .query<Row, Bindings>(
          `${visible} SELECT * ${match} ORDER BY started_at DESC, id DESC LIMIT $limit OFFSET $offset`,
        )
        .all({ ...query, $limit: params.limit, $offset: (params.page - 1) * params.limit }),
    ),
    count(`${visible} SELECT COUNT(*) AS n ${match}`),
    params,
  );
  const batchesFrom = ` FROM visible WHERE batch_id IN (SELECT batch_id ${match}) GROUP BY batch_id`;
  const batches = paginate(
    db
      .query<Row, Bindings>(
        `${visible} SELECT ${BATCH_AGG_COLS} ${batchesFrom} ORDER BY MIN(started_at) DESC, batch_id LIMIT 10 OFFSET $offset`,
      )
      .all({ ...query, $offset: (batchPage - 1) * 10 })
      .map(rowToBatchListItem),
    count(`${visible} SELECT COUNT(DISTINCT batch_id) AS n ${match}`),
    { page: batchPage, limit: 10 },
  );
  const stateCounts = Object.fromEntries(ALL_MIGRATION_STATES.map((state) => [state, 0])) as Record<
    MigrationState,
    number
  >;
  if (!q)
    for (const row of db
      .query<{ state: MigrationState; n: number }, typeof bindings>(
        `${visible} SELECT state, COUNT(*) AS n FROM visible GROUP BY state`,
      )
      .all(bindings))
      stateCounts[row.state] = row.n;
  return { migrations, batches, stateCounts: q ? null : stateCounts };
}

export function visibleBatch(userId: string, id: string, params: PaginationParams) {
  const bindings = { ...scope(userId), $id: id };
  const from = ` FROM visible WHERE batch_id = $id`;
  const db = getDb();
  const row = db
    .query<Row, Bindings>(`${visible} SELECT ${BATCH_AGG_COLS} ${from} GROUP BY batch_id`)
    .get(bindings);
  if (!row) return null;
  const summary = rowToBatchListItem(row);
  const migrations = paginate(
    rowsToMigrations(
      db
        .query<Row, Bindings>(`${visible} SELECT * ${from}
    ORDER BY source_repo, id LIMIT $limit OFFSET $offset`)
        .all({
          ...bindings,
          $limit: params.limit,
          $offset: (params.page - 1) * params.limit,
        }),
    ),
    summary.totalCount,
    params,
  );
  return { summary, migrations };
}
