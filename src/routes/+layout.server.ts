/** Server-side layout data — exposes auth mode, live rate limits, and active migration count. */
import type { LayoutServerLoad } from "./$types";
import { getAuthConfig, fetchLiveRateLimits } from "$lib/server/auth";
import { getActiveMigrationCount } from "$lib/server/store";

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
