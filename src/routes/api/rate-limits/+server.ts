import { json } from "@sveltejs/kit";
import { fetchLiveRateLimits } from "$lib/server/core/auth";
import { fetchGitHubStatus } from "$lib/server/core/github-status";
import { getActiveMigrationCount } from "$lib/server/migrate/database/stats";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () => {
  const [liveRates, ghStatus] = await Promise.all([fetchLiveRateLimits(), fetchGitHubStatus()]);
  return json({
    source: liveRates.source,
    target: liveRates.target,
    activeMigrations: getActiveMigrationCount(),
    ghStatus,
  });
};
