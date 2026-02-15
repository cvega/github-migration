/** Server-side layout data — exposes auth mode, live rate limits, and active migration count. */

import { fetchLiveRateLimits, getAuthConfig } from "$lib/server/auth";
import { getActiveMigrationCount } from "$lib/server/store";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async () => {
  const auth = getAuthConfig();

  // Fetch live rate limits (non-blocking — falls back to null on error).
  const liveRates = await fetchLiveRateLimits();
  if (liveRates.source) auth.source.rateLimitLive = liveRates.source;
  if (liveRates.target) auth.target.rateLimitLive = liveRates.target;

  const activeMigrations = getActiveMigrationCount();

  return {
    sourceAuth: auth.source,
    targetAuth: auth.target,
    activeMigrations,
  };
};
