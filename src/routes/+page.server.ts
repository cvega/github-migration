import { redirect } from "@sveltejs/kit";
import { getSetupReadiness } from "$lib/server/application/setup";
import { hasMigrationHistory } from "$lib/server/migrate/database/migrations";
import { hasProfileHistory } from "$lib/server/profile/database/runs";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  if (locals.user?.role === "operator") return {};
  const hasOperationalHistory = hasProfileHistory() || hasMigrationHistory();
  const setup = getSetupReadiness(hasOperationalHistory);

  if (setup.needsOnboarding) redirect(307, "/setup");

  return { setup };
};
