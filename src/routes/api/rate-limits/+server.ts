/** GET /api/rate-limits — live rate limit data for the navbar. */
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { fetchLiveRateLimits } from "$lib/server/auth";
import { getActiveMigrationCount } from "$lib/server/store";

export const GET: RequestHandler = async () => {
  const liveRates = await fetchLiveRateLimits();
  const activeMigrations = getActiveMigrationCount();
  return json({
    source: liveRates.source,
    target: liveRates.target,
    activeMigrations,
  });
};
