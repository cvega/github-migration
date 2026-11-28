import { getSetupReadiness } from "$lib/server/application/setup";
import { requireAdminIfAuthEnabled } from "$lib/server/core/auth/authorization";
import { hasMigrationHistory } from "$lib/server/migrate/database/migrations";
import { hasProfileHistory } from "$lib/server/profile/database/runs";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  requireAdminIfAuthEnabled(locals);
  const hasOperationalHistory = hasProfileHistory() || hasMigrationHistory();

  return { setup: getSetupReadiness(hasOperationalHistory) };
};
