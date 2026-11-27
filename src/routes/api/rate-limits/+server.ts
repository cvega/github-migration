import { json } from "@sveltejs/kit";
import { fetchLiveRateLimits } from "$lib/server/core/auth";
import { requireAdminIfAuthEnabled } from "$lib/server/core/auth/authorization";
import { fetchGitHubStatus } from "$lib/server/core/github-status";
import { getActiveMigrationCount, getMigrationCount } from "$lib/server/migrate/database/stats";
import { countProfileRuns } from "$lib/server/profile/database/runs";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ locals }) => {
  requireAdminIfAuthEnabled(locals);
  const [liveRates, ghStatus] = await Promise.all([fetchLiveRateLimits(), fetchGitHubStatus()]);
  return json({
    source: liveRates.source,
    target: liveRates.target,
    activeMigrations: getActiveMigrationCount(),
    migrationCount: getMigrationCount(),
    profileCount: countProfileRuns(),
    ghStatus,
  });
};
