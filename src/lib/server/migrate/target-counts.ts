import type { Counts, Migration } from "$lib/migrate/types";
import { getRepoCounts } from "$lib/server/core/github";
import { getMigrationTargetClient, requireMigrationTargetProfile } from "$lib/server/core/targets";

export const targetCountDependencies = { getRepoCounts };

export async function fetchMigrationTargetCounts(migration: Migration): Promise<Counts> {
  const target = requireMigrationTargetProfile(migration.targetProfileId);
  if (target.platform !== migration.targetPlatform || target.apiUrl !== migration.targetApiUrl) {
    throw new Error(
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
