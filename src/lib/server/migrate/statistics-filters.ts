import type {
  MigrationStatsFilters,
  MigrationStatsMode,
  MigrationStatsPeriod,
} from "$lib/migrate/types";
import type { SourceProvider } from "$lib/source-provider";
import type { TargetPlatform } from "$lib/target-platform";

export const DEFAULT_MIGRATION_STATS_FILTERS: MigrationStatsFilters = {
  period: "all",
  sourceProvider: "all",
  targetPlatform: "all",
  mode: "all",
};

const PERIODS = new Set<MigrationStatsPeriod>(["30d", "90d", "all"]);
const SOURCE_PROVIDERS = new Set<SourceProvider | "all">([
  "github",
  "gitlab",
  "bitbucket-server",
  "all",
]);
const TARGET_PLATFORMS = new Set<TargetPlatform | "all">(["ghec", "ghes", "all"]);
const MODES = new Set<MigrationStatsMode>(["single", "batch", "all"]);

function allowedValue<T extends string>(value: string | null, allowed: Set<T>, fallback: T): T {
  return value !== null && allowed.has(value as T) ? (value as T) : fallback;
}

export function parseMigrationStatsFilters(searchParams: URLSearchParams): MigrationStatsFilters {
  return {
    period: allowedValue(searchParams.get("period"), PERIODS, "all"),
    sourceProvider: allowedValue(searchParams.get("source"), SOURCE_PROVIDERS, "all"),
    targetPlatform: allowedValue(searchParams.get("target"), TARGET_PLATFORMS, "all"),
    mode: allowedValue(searchParams.get("mode"), MODES, "all"),
  };
}
