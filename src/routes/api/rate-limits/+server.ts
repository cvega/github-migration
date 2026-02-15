/** GET /api/rate-limits — live rate limit + GitHub status data for the navbar. */
import { json } from "@sveltejs/kit";
import { fetchLiveRateLimits } from "$lib/server/auth";
import { fetchGitHubStatus } from "$lib/server/github-status";
import { getActiveMigrationCount } from "$lib/server/store";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () => {
  const [liveRates, ghStatus] = await Promise.all([fetchLiveRateLimits(), fetchGitHubStatus()]);
  const activeMigrations = getActiveMigrationCount();
  return json({
    source: liveRates.source,
    target: liveRates.target,
    activeMigrations,
    ghStatus,
  });
};
