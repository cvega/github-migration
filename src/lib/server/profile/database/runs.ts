import { getDb } from "$lib/server/core/db";
import { assertMigrationSourceApiUrl } from "$lib/server/core/source-url";
import type { NumericObservation } from "$lib/source/types";
import {
  getSourceProviderAdapter,
  isSourceProvider,
  SOURCE_PROVIDERS,
  type SourceProvider,
} from "$lib/source-provider";
import { type ProfileInventorySummary, parseProfileInventorySummary } from "../analysis/overview";
import type { ProfileDetailRollup } from "../analysis/rollup";
import type { OrgResources, ProfileRun, ProfileRunState } from "../types";
import { parsePersistedOrgResources, parsePersistedProfileRollup } from "./results";

interface ProfileRunRow {
  id: string;
  source_provider: string;
  source_api_url: string;
  org: string;
  state: string;
  total_repos: number;
  profiled_repos: number;
  blockers: number;
  warnings: number;
  observed_org_ruleset_count: number | null;
  org_resources: string;
  api_calls: number;
  started_at: string;
  completed_at: string | null;
  failure_reason: string | null;
}

const RUN_COLS =
  "id, source_provider, source_api_url, org, state, total_repos, profiled_repos, blockers, warnings, observed_org_ruleset_count, org_resources, api_calls, started_at, completed_at, failure_reason";
const SUPPORTED_PROVIDER_SQL = SOURCE_PROVIDERS.map((provider) => `'${provider}'`).join(", ");

type SourceScope = { sourceProvider: SourceProvider; sourceApiUrl: string; namespace: string };

export function completedSourceRuns(scopes: SourceScope[] | null) {
  const from = "FROM profile_runs WHERE state='completed' AND completed_at IS NOT NULL";
  if (scopes === null) return { from, params: [] as string[] };
  return {
    from: `${from} AND (source_provider,source_api_url,org COLLATE BINARY) IN
      (SELECT value ->> 0,value ->> 1,value ->> 2 FROM json_each(?))`,
    params: [JSON.stringify(scopes.map((g) => [g.sourceProvider, g.sourceApiUrl, g.namespace]))],
  };
}

export function latestSourceReports(scopes: SourceScope[] | null) {
  const { from, params } = completedSourceRuns(scopes);
  return getDb()
    .query<SourceScope & { id: string }, string[]>(
      `SELECT id, namespace, sourceProvider, sourceApiUrl FROM (
      SELECT id, org AS namespace, source_provider AS sourceProvider, source_api_url AS sourceApiUrl,
        row_number() OVER (PARTITION BY source_provider,source_api_url,org COLLATE BINARY
          ORDER BY completed_at DESC,started_at DESC,id DESC) AS rank ${from}
    ) WHERE rank=1 ORDER BY namespace,sourceProvider,sourceApiUrl`,
    )
    .all(...params);
}

export class ProfileRunCapacityError extends Error {
  constructor(readonly sourceProvider: SourceProvider) {
    super(`A ${sourceProvider} profile is already running`);
    this.name = "ProfileRunCapacityError";
  }
}

function rowToRun(row: ProfileRunRow): ProfileRun {
  if (!isSourceProvider(row.source_provider)) {
    throw new Error(`Invalid stored source provider '${row.source_provider}'`);
  }
  return {
    id: row.id,
    sourceProvider: row.source_provider,
    sourceApiUrl: row.source_api_url,
    org: row.org,
    state: row.state as ProfileRunState,
    totalRepos: row.total_repos,
    profiledRepos: row.profiled_repos,
    blockers: row.blockers,
    warnings: row.warnings,
    orgRulesetCount: row.observed_org_ruleset_count,
    orgResources: parsePersistedOrgResources(row.org_resources),
    apiCalls: row.api_calls,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    failureReason: row.failure_reason,
  };
}

export function createProfileRun(input: {
  id: string;
  sourceProvider?: SourceProvider;
  sourceApiUrl: string;
  org: string;
  enforceCapacity?: boolean;
  nowMs?: number;
}): ProfileRun {
  const sourceProvider = input.sourceProvider ?? "github";
  assertMigrationSourceApiUrl(input.sourceApiUrl, sourceProvider);
  const startedAt = new Date(input.nowMs ?? Date.now()).toISOString();
  const database = getDb();
  database.transaction(() => {
    const capacityKey = getSourceProviderAdapter(sourceProvider).profileCapacityKey;
    const capacityProviders = SOURCE_PROVIDERS.filter(
      (provider) => getSourceProviderAdapter(provider).profileCapacityKey === capacityKey,
    );
    if (
      input.enforceCapacity &&
      capacityKey !== null &&
      database
        .prepare(
          `SELECT 1 FROM profile_runs
					 WHERE state = 'running'
						 AND source_provider IN (${capacityProviders.map(() => "?").join(", ")})
					 LIMIT 1`,
        )
        .get(...capacityProviders)
    ) {
      throw new ProfileRunCapacityError(sourceProvider);
    }
    database
      .prepare(
        `INSERT INTO profile_runs
					 (id, source_provider, source_api_url, org, state, started_at)
				 VALUES ($id, $provider, $url, $org, 'running', $started_at)`,
      )
      .run({
        $id: input.id,
        $provider: sourceProvider,
        $url: input.sourceApiUrl,
        $org: input.org,
        $started_at: startedAt,
      });
  })();
  const run = getProfileRun(input.id);
  if (!run) throw new Error(`Failed to create profile run '${input.id}'`);
  return run;
}

export function setProfileRunTotal(runId: string, total: number): void {
  getDb()
    .prepare("UPDATE profile_runs SET total_repos = $total WHERE id = $id AND state = 'running'")
    .run({ $id: runId, $total: total });
}

export function setProfileRunRulesets(runId: string, count: number | null): void {
  getDb()
    .prepare(
      "UPDATE profile_runs SET observed_org_ruleset_count = $count WHERE id = $id AND state = 'running'",
    )
    .run({ $id: runId, $count: count });
}

export function setProfileRunOrgResources(runId: string, resources: OrgResources): void {
  getDb()
    .prepare("UPDATE profile_runs SET org_resources = $json WHERE id = $id AND state = 'running'")
    .run({ $id: runId, $json: JSON.stringify({ counts: resources }) });
}

export function setProfileRunApiCalls(runId: string, count: number): void {
  getDb()
    .prepare("UPDATE profile_runs SET api_calls = $count WHERE id = $id AND state = 'running'")
    .run({ $id: runId, $count: count });
}

export function completeProfileRun(runId: string, nowMs?: number): void {
  getDb()
    .prepare(
      `UPDATE profile_runs SET
				 profiled_repos = (SELECT COUNT(*) FROM profile_repos WHERE run_id = $id),
				 blockers = (SELECT COALESCE(SUM(blockers), 0) FROM profile_repos WHERE run_id = $id),
				 warnings = (SELECT COALESCE(SUM(warnings), 0) FROM profile_repos WHERE run_id = $id),
				 state = 'completed',
				 completed_at = $completed_at
			 WHERE id = $id AND state = 'running'`,
    )
    .run({
      $completed_at: new Date(nowMs ?? Date.now()).toISOString(),
      $id: runId,
    });
}

export function saveProfileRunRollup(runId: string, rollup: ProfileDetailRollup): void {
  getDb()
    .prepare("UPDATE profile_runs SET detail_rollup = $rollup WHERE id = $id AND state = 'running'")
    .run({ $id: runId, $rollup: JSON.stringify(rollup) });
}

export function getProfileRunRollup(runId: string): ProfileDetailRollup | null {
  const row = getDb().prepare("SELECT detail_rollup FROM profile_runs WHERE id = ?").get(runId) as {
    detail_rollup: string | null;
  } | null;
  if (!row || row.detail_rollup === null) return null;
  return parsePersistedProfileRollup(row.detail_rollup);
}

export function failProfileRun(runId: string, reason: string, nowMs?: number): void {
  getDb()
    .prepare(
      `UPDATE profile_runs SET state = 'failed', failure_reason = $reason, completed_at = $completed_at
			 WHERE id = $id AND state = 'running'`,
    )
    .run({
      $reason: reason,
      $completed_at: new Date(nowMs ?? Date.now()).toISOString(),
      $id: runId,
    });
}

export function getProfileRun(id: string): ProfileRun | null {
  const row = getDb()
    .prepare(`SELECT ${RUN_COLS} FROM profile_runs WHERE id = $id`)
    .get({ $id: id }) as ProfileRunRow | null;
  return row && isSourceProvider(row.source_provider) ? rowToRun(row) : null;
}

export function listProfileRuns(limit = 50, offset = 0): ProfileRun[] {
  const rows = getDb()
    .prepare(
      `SELECT ${RUN_COLS} FROM profile_runs
			 WHERE source_provider IN (${SUPPORTED_PROVIDER_SQL})
			 ORDER BY started_at DESC LIMIT $limit OFFSET $offset`,
    )
    .all({ $limit: limit, $offset: offset }) as ProfileRunRow[];
  return rows.map(rowToRun);
}

export function profileSearch(query: string) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const text = `lower(org || ' ' || source_provider || CASE WHEN source_provider='bitbucket-server' THEN ' bitbucket data center' ELSE '' END)`;
  return {
    sql: terms.map(() => ` AND instr(${text}, ?) > 0`).join(""),
    terms,
  };
}

export function countProfileRuns(query = ""): number {
  const filter = profileSearch(query);
  return (
    getDb()
      .prepare(
        `SELECT COUNT(*) AS count FROM profile_runs
				 WHERE source_provider IN (${SUPPORTED_PROVIDER_SQL})${filter.sql}`,
      )
      .get(...filter.terms) as { count: number }
  ).count;
}

export interface ProfileRunListItem extends ProfileRun {
  inventoryProjectCount: NumericObservation | null;
  metrics?: ProfileInventorySummary["metrics"];
}

export function listProfileRunsWithInventoryCounts(
  limit = 50,
  offset = 0,
  query = "",
): ProfileRunListItem[] {
  const filter = profileSearch(query);
  const rows = getDb()
    .prepare(
      `SELECT ${RUN_COLS}, inventories.summary AS inventory_summary
			 FROM profile_runs
			 LEFT JOIN profile_source_inventories inventories ON inventories.run_id = profile_runs.id
			 WHERE source_provider IN (${SUPPORTED_PROVIDER_SQL})${filter.sql}
			 ORDER BY started_at DESC, profile_runs.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...filter.terms, limit, offset) as Array<
    ProfileRunRow & { inventory_summary: string | null }
  >;
  return rows.map((row) => {
    const run = rowToRun(row);
    let inventoryProjectCount: NumericObservation | null = null;
    let metrics: ProfileInventorySummary["metrics"];
    if (
      row.inventory_summary &&
      getSourceProviderAdapter(run.sourceProvider).profileKind === "source-inventory"
    ) {
      try {
        const summary = parseProfileInventorySummary(JSON.parse(row.inventory_summary));
        inventoryProjectCount = summary.projectCount;
        metrics = summary.metrics;
      } catch {
        inventoryProjectCount = null;
      }
    }
    return { ...run, inventoryProjectCount, ...(metrics && { metrics }) };
  });
}
