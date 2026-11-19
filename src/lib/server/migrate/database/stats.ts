import type {
  Counts,
  MigrationDirectionStats,
  MigrationState,
  MigrationStats,
  MigrationStatsFilters,
} from "$lib/migrate/types";
import {
  CAPACITY_MIGRATION_STATES,
  isFinishedMigrationState,
  migrationStatesSql,
  TERMINAL_MIGRATION_STATES,
} from "$lib/migration-state";
import { REPOSITORY_SIZE_BANDS, repositorySizeBand } from "$lib/repository-size";
import { getDb } from "$lib/server/core/db";
import { DEFAULT_MIGRATION_STATS_FILTERS } from "$lib/server/migrate/statistics-filters";
import { getGitHubSourcePlatform } from "$lib/source-provider";
import { EXECUTABLE_PROVIDER_SQL } from "./migrations";

const DAY_MS = 24 * 60 * 60 * 1000;

function buildStatisticsWhere(
  filters: MigrationStatsFilters,
  now: Date,
): { sql: string; parameters: Record<string, string> } {
  const clauses = [`source_provider IN (${EXECUTABLE_PROVIDER_SQL})`];
  const parameters: Record<string, string> = {};
  if (filters.period !== "all") {
    const days = filters.period === "30d" ? 30 : 90;
    parameters.$stats_started_after = new Date(now.getTime() - days * DAY_MS).toISOString();
    clauses.push("started_at >= $stats_started_after");
  }
  if (filters.sourceProvider !== "all") {
    parameters.$stats_source_provider = filters.sourceProvider;
    clauses.push("source_provider = $stats_source_provider");
  }
  if (filters.targetPlatform !== "all") {
    parameters.$stats_target_platform = filters.targetPlatform;
    clauses.push("target_platform = $stats_target_platform");
  }
  if (filters.mode === "single") clauses.push("batch_id IS NULL");
  if (filters.mode === "batch") clauses.push("batch_id IS NOT NULL");
  return { sql: clauses.join(" AND "), parameters };
}

function durationDistribution(values: number[], eligibleCount: number) {
  if (values.length === 0) {
    return {
      avgSeconds: null,
      medianSeconds: null,
      p95Seconds: null,
      timedCount: 0,
      eligibleCount,
    };
  }
  values.sort((left, right) => left - right);
  const middle = Math.floor(values.length / 2);
  const medianSeconds =
    values.length % 2 === 0
      ? ((values[middle - 1] ?? 0) + (values[middle] ?? 0)) / 2
      : values[middle];
  return {
    avgSeconds: values.reduce((total, value) => total + value, 0) / values.length,
    medianSeconds: medianSeconds ?? null,
    p95Seconds: values[Math.ceil(values.length * 0.95) - 1] ?? null,
    timedCount: values.length,
    eligibleCount,
  };
}

export function getActiveMigrationCount(): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS count FROM migrations
			 WHERE source_provider IN (${EXECUTABLE_PROVIDER_SQL})
				 AND state IN (${migrationStatesSql(CAPACITY_MIGRATION_STATES)})`,
    )
    .get() as { count: number };
  return row.count;
}

export function getMigrationCount(): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS count FROM migrations
			 WHERE source_provider IN (${EXECUTABLE_PROVIDER_SQL})`,
    )
    .get() as { count: number };
  return row.count;
}

export function getStateCounts(): Record<MigrationState, number> {
  const counts: Record<MigrationState, number> = {
    queued: 0,
    pending: 0,
    running: 0,
    cancelling: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    reconciliation_required: 0,
  };
  const rows = getDb()
    .prepare(
      `SELECT state, COUNT(*) AS count FROM migrations
			 WHERE source_provider IN (${EXECUTABLE_PROVIDER_SQL}) GROUP BY state`,
    )
    .all() as Array<{ state: string; count: number }>;
  for (const row of rows) counts[row.state as MigrationState] = row.count;
  return counts;
}

export function getMigrationStats(
  filters: MigrationStatsFilters = DEFAULT_MIGRATION_STATS_FILTERS,
  now = new Date(),
): MigrationStats {
  const database = getDb();
  const { sql: statisticsWhere, parameters } = buildStatisticsWhere(filters, now);
  const migrationRows = database
    .prepare(
      `SELECT state, source_provider, source_api_url, target_platform,
				elapsed_seconds, source_size_kb, source_org, source_repo,
				warnings_count, batch_id, completed_at, failure_reason
			 FROM migrations WHERE ${statisticsWhere}`,
    )
    .all(parameters) as Array<{
    state: MigrationState;
    source_provider: MigrationDirectionStats["sourceProvider"];
    source_api_url: string;
    target_platform: MigrationDirectionStats["targetPlatform"];
    elapsed_seconds: number | null;
    source_size_kb: number | null;
    source_org: string;
    source_repo: string;
    warnings_count: number;
    batch_id: string | null;
    completed_at: string | null;
    failure_reason: string | null;
  }>;

  const byState: Record<MigrationState, number> = {
    queued: 0,
    pending: 0,
    running: 0,
    cancelling: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    reconciliation_required: 0,
  };
  const directionsByKey = new Map<
    string,
    Omit<MigrationDirectionStats, "rate" | "duration"> & { durations: number[] }
  >();
  const sizeByBand = new Map(
    REPOSITORY_SIZE_BANDS.map((definition) => [
      definition.band,
      { succeeded: 0, failed: 0, durations: [] as number[] },
    ]),
  );
  const organizationCounts = new Map<
    string,
    { org: string; provider: string; host: string; count: number }
  >();
  const batchIds = new Set<string>();
  const throughputByDate = new Map<string, { succeeded: number; failed: number }>();
  const failuresByReason = new Map<
    string,
    { count: number; totalSeconds: number; timedCount: number }
  >();
  const successfulDurations: number[] = [];
  let total = 0;
  let totalWarnings = 0;
  let migrationsWithWarnings = 0;
  let successfulSizeTotal = 0;
  let successfulSizedCount = 0;
  let sizeUnavailableCount = 0;
  let failuresWithoutReason = 0;
  let batchFailures = 0;
  let largest: { repo: string; kb: number } | null = null;
  let fastest: { repo: string; seconds: number } | null = null;
  let slowest: { repo: string; seconds: number } | null = null;

  for (const row of migrationRows) {
    const sizeKb =
      row.source_size_kb !== null &&
      Number.isSafeInteger(row.source_size_kb) &&
      row.source_size_kb >= 0
        ? row.source_size_kb
        : null;
    byState[row.state] += 1;
    total += 1;
    totalWarnings += row.warnings_count;
    if (row.warnings_count > 0) migrationsWithWarnings += 1;
    const orgKey = JSON.stringify([row.source_provider, row.source_api_url, row.source_org]);
    const org = organizationCounts.get(orgKey) ?? {
      org: row.source_org,
      provider: row.source_provider,
      host: URL.canParse(row.source_api_url)
        ? new URL(row.source_api_url).host
        : row.source_api_url,
      count: 0,
    };
    org.count += 1;
    organizationCounts.set(orgKey, org);
    if (row.batch_id !== null) batchIds.add(row.batch_id);
    if (row.batch_id !== null && row.state === "failed") batchFailures += 1;
    if (sizeKb === null) sizeUnavailableCount += 1;
    if (row.state === "failed" && !row.failure_reason?.trim()) failuresWithoutReason += 1;
    if (row.state === "failed" && row.failure_reason?.trim()) {
      const failure = failuresByReason.get(row.failure_reason) ?? {
        count: 0,
        totalSeconds: 0,
        timedCount: 0,
      };
      failure.count += 1;
      if (row.elapsed_seconds !== null) {
        failure.totalSeconds += row.elapsed_seconds;
        failure.timedCount += 1;
      }
      failuresByReason.set(row.failure_reason, failure);
    }
    if (row.completed_at !== null && (row.state === "succeeded" || row.state === "failed")) {
      const date = row.completed_at.slice(0, 10);
      const day = throughputByDate.get(date) ?? { succeeded: 0, failed: 0 };
      day[row.state] += 1;
      throughputByDate.set(date, day);
    }

    const githubSourcePlatform =
      row.source_provider === "github" ? getGitHubSourcePlatform(row.source_api_url) : null;
    const directionKey = `${row.source_provider}:${githubSourcePlatform}:${row.target_platform}`;
    const direction = directionsByKey.get(directionKey) ?? {
      sourceProvider: row.source_provider,
      githubSourcePlatform,
      targetPlatform: row.target_platform,
      total: 0,
      finished: 0,
      outcomes: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      durations: [],
    };
    direction.total += 1;
    if (isFinishedMigrationState(row.state)) direction.finished += 1;
    if (row.state === "succeeded" || row.state === "failed") direction.outcomes += 1;
    if (row.state === "succeeded") {
      direction.succeeded += 1;
      if (row.elapsed_seconds !== null) {
        direction.durations.push(row.elapsed_seconds);
        successfulDurations.push(row.elapsed_seconds);
        const record = {
          repo: `${row.source_org}/${row.source_repo}`,
          seconds: row.elapsed_seconds,
        };
        if (row.elapsed_seconds > 0 && (!fastest || row.elapsed_seconds < fastest.seconds)) {
          fastest = record;
        }
        if (!slowest || row.elapsed_seconds > slowest.seconds) slowest = record;
      }
      if (sizeKb !== null) {
        successfulSizeTotal += sizeKb;
        successfulSizedCount += 1;
        if (!largest || sizeKb > largest.kb) {
          largest = { repo: `${row.source_org}/${row.source_repo}`, kb: sizeKb };
        }
      }
    }
    if (row.state === "failed") direction.failed += 1;
    if (row.state === "cancelled") direction.cancelled += 1;
    directionsByKey.set(directionKey, direction);

    if (sizeKb !== null) {
      const sizeSummary = sizeByBand.get(repositorySizeBand(sizeKb))!;
      if (row.state === "succeeded") {
        sizeSummary.succeeded += 1;
        if (row.elapsed_seconds !== null) sizeSummary.durations.push(row.elapsed_seconds);
      }
      if (row.state === "failed") sizeSummary.failed += 1;
    }
  }

  const outcomes = byState.succeeded + byState.failed;
  const resolved = outcomes + byState.cancelled;
  const finished = resolved;
  const active = byState.queued + byState.pending + byState.running + byState.cancelling;
  const needsReview = byState.reconciliation_required;
  const successRate = outcomes > 0 ? Math.round((byState.succeeded / outcomes) * 1000) / 10 : null;
  const cancellationRate =
    resolved > 0 ? Math.round((byState.cancelled / resolved) * 1000) / 10 : 0;
  const duration = durationDistribution(successfulDurations, byState.succeeded);
  const durationTotal = successfulDurations.reduce((sum, seconds) => sum + seconds, 0);
  const directions: MigrationDirectionStats[] = [...directionsByKey]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, direction]) => {
      const { durations, ...summary } = direction;
      return {
        ...summary,
        rate:
          direction.outcomes > 0
            ? Math.round((direction.succeeded / direction.outcomes) * 1000) / 10
            : 0,
        duration: durationDistribution(durations, direction.succeeded),
      };
    });
  const topOrgs = [...organizationCounts]
    .map(([key, value]) => ({ key, ...value }))
    .sort(
      (left, right) =>
        right.count - left.count ||
        left.org.localeCompare(right.org) ||
        left.key.localeCompare(right.key),
    )
    .slice(0, 6);
  const failureStats = [...failuresByReason]
    .map(([reason, failure]) => ({ reason, ...failure }))
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason))
    .slice(0, 100)
    .map((failure) => ({
      reason: failure.reason,
      count: failure.count,
      share: Math.round((failure.count / byState.failed) * 1000) / 10,
      avgSeconds: failure.timedCount > 0 ? failure.totalSeconds / failure.timedCount : null,
      totalSeconds: failure.timedCount > 0 ? failure.totalSeconds : null,
      timedCount: failure.timedCount,
    }));
  const sizeStats = REPOSITORY_SIZE_BANDS.map((definition) => {
    const summary = sizeByBand.get(definition.band)!;
    const outcomesForBand = summary.succeeded + summary.failed;
    const distribution = durationDistribution(summary.durations, summary.succeeded);
    return {
      band: definition.band,
      outcomes: outcomesForBand,
      succeeded: summary.succeeded,
      failed: summary.failed,
      rate: outcomesForBand > 0 ? Math.round((summary.succeeded / outcomesForBand) * 1000) / 10 : 0,
      duration: {
        medianSeconds: distribution.medianSeconds,
        p95Seconds: distribution.p95Seconds,
        timedCount: distribution.timedCount,
        eligibleCount: distribution.eligibleCount,
      },
    };
  });
  const batchRows = database
    .prepare(
      `SELECT batch_id, COUNT(*) AS total,
				SUM(CASE WHEN state IN (${migrationStatesSql(TERMINAL_MIGRATION_STATES)}) THEN 1 ELSE 0 END) AS completed,
				SUM(CASE WHEN state = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
				SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failed,
				SUM(CASE WHEN state = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
				SUM(CASE WHEN state = 'reconciliation_required' THEN 1 ELSE 0 END) AS needs_review,
				SUM(CASE WHEN state IN ('queued', 'pending', 'running', 'cancelling') THEN 1 ELSE 0 END) AS active,
				MIN(started_at) AS started_at,
				MAX(completed_at) AS completed_at
			 FROM migrations WHERE ${statisticsWhere} AND batch_id IS NOT NULL
			 GROUP BY batch_id`,
    )
    .all(parameters) as Array<{
    batch_id: string;
    total: number;
    completed: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    needs_review: number;
    active: number;
    started_at: string;
    completed_at: string | null;
  }>;
  const batchStats = batchRows
    .map((row) => {
      const startedTimestamp = Date.parse(row.started_at);
      const completedTimestamp = row.completed_at ? Date.parse(row.completed_at) : Number.NaN;
      const activeBatch = row.active > 0;
      const elapsedEnd = activeBatch ? now.getTime() : completedTimestamp;
      const elapsedSeconds =
        Number.isFinite(startedTimestamp) && Number.isFinite(elapsedEnd)
          ? Math.max(0, Math.round((elapsedEnd - startedTimestamp) / 1000))
          : null;
      return {
        id: row.batch_id,
        total: row.total,
        completed: row.completed,
        completionRate: Math.round((row.completed / row.total) * 1000) / 10,
        succeeded: row.succeeded,
        failed: row.failed,
        cancelled: row.cancelled,
        needsReview: row.needs_review,
        active: activeBatch,
        needsAttention: activeBatch || row.failed > 0 || row.needs_review > 0,
        elapsedSeconds,
        startedAt: row.started_at,
      };
    })
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  const attentionBatches = batchStats.filter((batch) => batch.needsAttention).slice(0, 5);
  const recentCompletedBatches = batchStats.filter((batch) => !batch.needsAttention).slice(0, 5);
  const observedThroughput = [...throughputByDate]
    .map(([date, counts]) => ({ date, ...counts }))
    .sort((left, right) => left.date.localeCompare(right.date));
  const latestObservedDate = observedThroughput.at(-1)?.date ?? null;
  const earliestObservedDate = observedThroughput[0]?.date ?? null;
  const latestObservedTimestamp = latestObservedDate
    ? Date.parse(`${latestObservedDate}T00:00:00Z`)
    : Number.NaN;
  const earliestObservedTimestamp = earliestObservedDate
    ? Date.parse(`${earliestObservedDate}T00:00:00Z`)
    : Number.NaN;
  const throughputDays = Number.isFinite(earliestObservedTimestamp)
    ? Math.round((latestObservedTimestamp - earliestObservedTimestamp) / DAY_MS) + 1
    : 0;
  const throughputIntervalDays = throughputDays <= 210 ? 1 : Math.ceil(throughputDays / 1470) * 7;
  const throughput = Array.from(
    { length: Math.ceil(throughputDays / throughputIntervalDays) },
    (_, index) => {
      const start = earliestObservedTimestamp + index * throughputIntervalDays * DAY_MS;
      const end = Math.min(start + (throughputIntervalDays - 1) * DAY_MS, latestObservedTimestamp);
      return {
        date: new Date(start).toISOString().slice(0, 10),
        endDate: new Date(end).toISOString().slice(0, 10),
        succeeded: 0,
        failed: 0,
      };
    },
  );
  for (const day of observedThroughput) {
    const timestamp = Date.parse(`${day.date}T00:00:00Z`);
    const index = Math.floor(
      (timestamp - earliestObservedTimestamp) / (throughputIntervalDays * DAY_MS),
    );
    const interval = throughput[index];
    if (interval) {
      interval.succeeded += day.succeeded;
      interval.failed += day.failed;
    }
  }

  const today = now.toISOString().slice(0, 10);
  const todayTimestamp = Date.parse(`${today}T00:00:00Z`);
  let recentSucceeded = 0;
  let recentFailed = 0;
  let previousCompleted = 0;
  for (const row of migrationRows) {
    if (!row.completed_at || (row.state !== "succeeded" && row.state !== "failed")) continue;
    const completedTimestamp = Date.parse(row.completed_at);
    if (!Number.isFinite(completedTimestamp) || completedTimestamp > now.getTime()) continue;
    const daysAgo = Math.round(
      (todayTimestamp - Date.parse(`${row.completed_at.slice(0, 10)}T00:00:00Z`)) / DAY_MS,
    );
    if (daysAgo >= 0 && daysAgo <= 6) {
      if (row.state === "succeeded") recentSucceeded += 1;
      else recentFailed += 1;
    } else if (daysAgo >= 7 && daysAgo <= 13) {
      previousCompleted += 1;
    }
  }
  const recentCompleted = recentSucceeded + recentFailed;
  const recentSuccessRate =
    recentCompleted > 0 ? Math.round((recentSucceeded / recentCompleted) * 1000) / 10 : null;
  const volumeChangePct =
    previousCompleted > 0
      ? Math.round(((recentCompleted - previousCompleted) / previousCompleted) * 1000) / 10
      : null;
  const resourceRow = database
    .prepare(
      `SELECT
				SUM(COALESCE(json_extract(target_counts, '$.commits'), 0)) AS commits,
				SUM(COALESCE(json_extract(target_counts, '$.branches'), 0)) AS branches,
				SUM(COALESCE(json_extract(target_counts, '$.tags'), 0)) AS tags,
				SUM(COALESCE(json_extract(target_counts, '$.issues'), 0)) AS issues,
				SUM(COALESCE(json_extract(target_counts, '$.pullRequests'), 0)) AS pull_requests,
				SUM(COALESCE(json_extract(target_counts, '$.releases'), 0)) AS releases,
				COUNT(*) AS migration_count
			 FROM migrations WHERE ${statisticsWhere} AND state = 'succeeded'
				 AND CASE WHEN json_valid(target_counts) THEN
           json_type(target_counts, '$.commits') = 'integer' AND json_extract(target_counts, '$.commits') >= 0
           AND json_type(target_counts, '$.branches') = 'integer' AND json_extract(target_counts, '$.branches') >= 0
           AND json_type(target_counts, '$.tags') = 'integer' AND json_extract(target_counts, '$.tags') >= 0
           AND json_type(target_counts, '$.issues') = 'integer' AND json_extract(target_counts, '$.issues') >= 0
           AND json_type(target_counts, '$.pullRequests') = 'integer' AND json_extract(target_counts, '$.pullRequests') >= 0
           AND json_type(target_counts, '$.releases') = 'integer' AND json_extract(target_counts, '$.releases') >= 0
         ELSE 0 END`,
    )
    .get(parameters) as {
    commits: number | null;
    branches: number | null;
    tags: number | null;
    issues: number | null;
    pull_requests: number | null;
    releases: number | null;
    migration_count: number | null;
  };
  const resources: Counts & { migrationCount: number } = {
    commits: resourceRow.commits ?? 0,
    branches: resourceRow.branches ?? 0,
    tags: resourceRow.tags ?? 0,
    issues: resourceRow.issues ?? 0,
    pullRequests: resourceRow.pull_requests ?? 0,
    releases: resourceRow.releases ?? 0,
    migrationCount: resourceRow.migration_count ?? 0,
  };

  return {
    total,
    byState,
    finished,
    outcomes,
    resolved,
    active,
    needsReview,
    successRate,
    cancellationRate,
    duration: {
      avgSeconds: duration.avgSeconds,
      medianSeconds: duration.medianSeconds,
      p95Seconds: duration.p95Seconds,
      totalSeconds: durationTotal,
      minSeconds: successfulDurations.at(0) ?? null,
      maxSeconds: successfulDurations.at(-1) ?? null,
      timedCount: duration.timedCount,
      eligibleCount: duration.eligibleCount,
    },
    data: {
      totalKb: successfulSizeTotal,
      avgKb: successfulSizedCount > 0 ? successfulSizeTotal / successfulSizedCount : null,
      largestKb: largest?.kb ?? null,
      largestRepo: largest?.repo ?? null,
      sizedCount: successfulSizedCount,
      eligibleCount: byState.succeeded,
    },
    resources,
    directions,
    warnings: { total: totalWarnings, withWarnings: migrationsWithWarnings },
    records: { fastest, slowest },
    topOrgs,
    failuresByReason: failureStats,
    failuresWithoutReason,
    batchFailures,
    sizeStats,
    sizeUnavailableCount,
    batchStats: [...attentionBatches, ...recentCompletedBatches],
    throughput,
    throughputIntervalDays,
    recentWindow: {
      endingOn: today,
      completed: recentCompleted,
      succeeded: recentSucceeded,
      failed: recentFailed,
      successRate: recentSuccessRate,
      previousCompleted,
      volumeChangePct,
    },
    batches: batchIds.size,
  };
}
