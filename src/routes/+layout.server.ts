/** Server-side layout data — exposes auth mode, live rate limits, and active migration count. */

import {
  fetchLiveRateLimits,
  getAuthConfig,
  getFormDefaults,
  isCredentialOverrideAllowed,
} from "$lib/server/auth";
import { fetchGitHubStatus } from "$lib/server/core/github-status";
import { MAX_CONCURRENT, recentActivity } from "$lib/server/manager";
import { getActiveMigrationCount } from "$lib/server/migrate/store";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ locals }) => {
  const auth = getAuthConfig();

  // Fetch live rate limits and GitHub platform status in parallel.
  const [liveRates, ghStatus] = await Promise.all([fetchLiveRateLimits(), fetchGitHubStatus()]);
  if (liveRates.source) auth.source.rateLimitLive = liveRates.source;
  if (liveRates.target) auth.target.rateLimitLive = liveRates.target;

  const activeMigrations = getActiveMigrationCount();

  return {
    sourceAuth: auth.source,
    targetAuth: auth.target,
    allowCredentialOverride: isCredentialOverrideAllowed(),
    formDefaults: getFormDefaults(),
    activeMigrations,
    maxConcurrent: MAX_CONCURRENT,
    ghStatus,
    recentActivity: recentActivity(20),
    authEnabled: locals.authEnabled ?? false,
  };
};
