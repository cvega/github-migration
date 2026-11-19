import { ALL_MIGRATION_STATES, migrationStatesSql } from "$lib/migration-state";
import { getDb } from "$lib/server/core/db";
import { getMigrationExecutor, SOURCE_PROVIDERS } from "$lib/source-provider";
import { TARGET_PLATFORMS } from "$lib/target-platform";
import { EXECUTABLE_PROVIDER_SQL } from "./migrations";

interface MetricRow {
  source: string;
  target: string;
  mode: string;
  state: string;
  migrations: number;
  durationCount: number;
  durationSeconds: number;
}

/**
 * Counts describe the currently retained migration rows, not lifetime events.
 * The fixed label sets avoid exposing repository identities or unbounded values.
 */
export function getMigrationMetrics(): string {
  const rows = getDb()
    .prepare(
      `SELECT source_provider AS source,
        CASE WHEN target_platform IN ('ghec', 'ghes') THEN target_platform ELSE 'other' END AS target,
        CASE WHEN batch_id IS NULL THEN 'single' ELSE 'batch' END AS mode,
        CASE WHEN state IN (${migrationStatesSql(ALL_MIGRATION_STATES)}) THEN state ELSE 'other' END AS state,
        COUNT(*) AS migrations,
        COUNT(CASE WHEN typeof(elapsed_seconds) IN ('integer', 'real') AND elapsed_seconds >= 0
          THEN elapsed_seconds END) AS durationCount,
        COALESCE(SUM(CASE WHEN typeof(elapsed_seconds) IN ('integer', 'real') AND elapsed_seconds >= 0
          THEN elapsed_seconds ELSE 0 END), 0) AS durationSeconds
       FROM migrations WHERE source_provider IN (${EXECUTABLE_PROVIDER_SQL})
       GROUP BY 1, 2, 3, 4`,
    )
    .all() as MetricRow[];

  const key = (source: string, target: string, mode: string, state: string) =>
    JSON.stringify([source, target, mode, state]);
  const counts = new Map(
    rows.map((row) => [key(row.source, row.target, row.mode, row.state), row]),
  );
  const families = [
    {
      name: "gh_migrate_migrations",
      help: "Currently retained migration records by current state.",
      value: (row: MetricRow | undefined) => row?.migrations ?? 0,
    },
    {
      name: "gh_migrate_migration_duration_observations",
      help: "Retained migration records with a nonnegative recorded duration.",
      value: (row: MetricRow | undefined) => row?.durationCount ?? 0,
    },
    {
      name: "gh_migrate_migration_duration_observed_seconds",
      help: "Sum of nonnegative recorded durations for retained migration records, in seconds.",
      value: (row: MetricRow | undefined) => row?.durationSeconds ?? 0,
    },
  ];
  const lines: string[] = [];
  for (const family of families) {
    lines.push(`# HELP ${family.name} ${family.help}`, `# TYPE ${family.name} gauge`);
    for (const source of SOURCE_PROVIDERS.filter(
      (provider) => getMigrationExecutor(provider) !== null,
    )) {
      for (const target of [...TARGET_PLATFORMS, "other"]) {
        for (const mode of ["single", "batch"]) {
          for (const state of [...ALL_MIGRATION_STATES, "other"]) {
            const value = family.value(counts.get(key(source, target, mode, state)));
            if (!Number.isFinite(value)) throw new Error("Non-finite migration metrics value");
            lines.push(
              `${family.name}{source="${source}",target="${target}",mode="${mode}",state="${state}"} ${value}`,
            );
          }
        }
      }
    }
  }
  return `${lines.join("\n")}\n`;
}
