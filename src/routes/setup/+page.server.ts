import { getSetupReadiness } from "$lib/server/application/setup";
import { requireAdminIfAuthEnabled } from "$lib/server/core/auth/authorization";
import { listMigrationsPaginated } from "$lib/server/migrate/database/migrations";
import { listProfileRuns } from "$lib/server/profile/database/runs";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  requireAdminIfAuthEnabled(locals);
  const hasOperationalHistory =
    listProfileRuns(1).length > 0 || listMigrationsPaginated({ page: 1, limit: 1 }).total > 0;

  return { setup: getSetupReadiness(hasOperationalHistory) };
};
