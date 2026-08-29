import {
  getAuthConfig,
  getCachedLiveRateLimits,
  getFormDefaults,
  isCredentialOverrideAllowed,
} from "$lib/server/core/auth";
import { getCachedGitHubStatus } from "$lib/server/core/github-status";
import { isValidSession, SESSION_COOKIE } from "$lib/server/core/session";
import { getMigrationTargetProfiles } from "$lib/server/core/targets";
import { getActiveMigrationCount } from "$lib/server/migrate/database/stats";
import { MAX_CONCURRENT_MIGRATIONS, recentActivity } from "$lib/server/migrate/manager";
import { getSetupReadiness } from "$lib/server/setup";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = ({ cookies, locals }) => {
  const authEnabled = locals.authEnabled ?? false;
  if (authEnabled) {
    const session = cookies.get(SESSION_COOKIE);
    if (!session || !isValidSession(session)) return { authEnabled: true };
  }

  const auth = getAuthConfig();
  const liveRates = getCachedLiveRateLimits();
  const ghStatus = getCachedGitHubStatus();
  if (liveRates.source) auth.source.rateLimitLive = liveRates.source;
  if (liveRates.target) auth.target.rateLimitLive = liveRates.target;

  const setup = getSetupReadiness(true);
  const capabilityFor = (sourceProvider: string, targetProfileId: string) =>
    setup.capabilityReport.migrations.find(
      (capability) =>
        capability.sourceProvider === sourceProvider &&
        capability.targetProfileId === targetProfileId,
    );

  return {
    sourceAuth: auth.source,
    targetAuth: auth.target,
    allowCredentialOverride: isCredentialOverrideAllowed(),
    formDefaults: getFormDefaults(),
    targetProfiles: getMigrationTargetProfiles().map((profile) => {
      const capabilities = setup.capabilityReport.migrations.filter(
        (capability) => capability.targetProfileId === profile.id,
      );
      return {
        ...profile,
        capabilities,
        serverMigrationReady: capabilities.some((capability) => capability.status === "ready"),
        executionReady:
          profile.platform === "ghec"
            ? setup.targetAuthReady
            : capabilities.some((capability) => capability.status === "ready"),
        executionReadySources: capabilities
          .filter((capability) => capability.status === "ready")
          .map((capability) => capability.sourceProvider),
      };
    }),
    activeMigrations: getActiveMigrationCount(),
    maxConcurrent: MAX_CONCURRENT_MIGRATIONS,
    ghStatus,
    recentActivity: recentActivity(20),
    authEnabled,
    setupComplete: setup.complete,
    gitlabSourceApiUrl: setup.gitlabSourceApiUrl,
    gitlabSourceAuthReady: setup.gitlabSourceAuthReady,
    gitlabMigrationReady: capabilityFor("gitlab", "ghec")?.status === "ready",
    gitlabNamespaces: (process.env.GITLAB_SOURCE_NAMESPACE ?? "")
      .split(/[\s,]+/)
      .map((value) => value.trim())
      .filter(Boolean),
    bitbucketSourceApiUrl: setup.bitbucketSourceApiUrl,
    bitbucketSourceAuthReady: setup.bitbucketSourceAuthReady,
    bitbucketMigrationReady: capabilityFor("bitbucket-server", "ghec")?.status === "ready",
    bitbucketProjectKeys: (process.env.BITBUCKET_SERVER_PROJECT_KEYS ?? "")
      .split(/[\s,]+/)
      .map((value) => value.trim())
      .filter(Boolean),
  };
};
