import { requireAdminIfAuthEnabled } from "$lib/server/core/auth/authorization";
import { stats } from "$lib/server/migrate/manager";
import { parseMigrationStatsFilters } from "$lib/server/migrate/statistics-filters";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ url, locals }) => {
  requireAdminIfAuthEnabled(locals);
  const filters = parseMigrationStatsFilters(url.searchParams);
  return { filters, stats: stats(filters) };
};
