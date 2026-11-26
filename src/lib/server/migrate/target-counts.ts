import type { Counts, Migration } from "$lib/migrate/types";
import { getRepoCounts } from "$lib/server/core/github";
import { getMigrationTargetClient, getMigrationTargetProfile } from "$lib/server/core/targets";

export const targetCountDependencies = { getRepoCounts };

class TargetCountConfigurationError extends Error {}

export function targetCountFailureReason(error: unknown): string {
  return error instanceof TargetCountConfigurationError ? error.message : "Target API unavailable";
}

export async function fetchMigrationTargetCounts(migration: Migration): Promise<Counts> {
  const target = getMigrationTargetProfile(migration.targetProfileId);
  if (!target)
    throw new TargetCountConfigurationError("The recorded target profile is not configured");
  if (target.platform !== migration.targetPlatform || target.apiUrl !== migration.targetApiUrl) {
    throw new TargetCountConfigurationError(
      "The configured target has changed since this migration. Restore its target profile before fetching counts.",
    );
  }
  const client = getMigrationTargetClient(target);
  return targetCountDependencies.getRepoCounts(
    client,
    client.graphql,
    migration.targetOrg,
    migration.targetRepo,
  );
}
