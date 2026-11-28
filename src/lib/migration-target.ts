import type { SourceProvider } from "$lib/source/types";
import { getMigrationExecutor } from "$lib/source-provider";
import { TARGET_PLATFORMS, type TargetPlatform } from "$lib/target-platform";

export { TARGET_PLATFORMS, type TargetPlatform } from "$lib/target-platform";

export interface MigrationTargetProfile {
  id: string;
  platform: TargetPlatform;
  displayName: string;
  apiUrl: string;
  webUrl: string;
  organizations: string[];
}

export const DEFAULT_TARGET_PROFILE_ID = "ghec";

const TARGET_PLATFORM_PRESENTATION: Record<
  TargetPlatform,
  { label: string; displayName: string; icon: "mark-github" }
> = {
  ghec: { label: "GHEC", displayName: "GitHub Enterprise Cloud", icon: "mark-github" },
  ghes: { label: "GHES", displayName: "GitHub Enterprise Server", icon: "mark-github" },
};

export const GITLAB_GHES_PAUSE_REASON = "GitLab-to-GHES migration execution is paused";

/** GHEC has one built-in profile. Never dispatch a conflicting target identity as cloud work. */
export function isPausedPersistedRoute(route: {
  routeExecutionPaused?: true;
  sourceProvider: SourceProvider;
  targetPlatform: TargetPlatform;
  targetProfileId: string;
  targetApiUrl: string;
}): boolean {
  return (
    route.sourceProvider === "gitlab" &&
    (route.routeExecutionPaused === true ||
      route.targetPlatform !== "ghec" ||
      route.targetProfileId !== DEFAULT_TARGET_PROFILE_ID ||
      route.targetApiUrl !== "https://api.github.com")
  );
}

export function isTargetPlatform(value: unknown): value is TargetPlatform {
  return TARGET_PLATFORMS.includes(value as TargetPlatform);
}

export function getTargetPlatformPresentation(targetPlatform: TargetPlatform) {
  return TARGET_PLATFORM_PRESENTATION[targetPlatform];
}

export function supportsMigrationTarget(
  sourceProvider: SourceProvider,
  targetPlatform: TargetPlatform,
): boolean {
  return getMigrationExecutor(sourceProvider, targetPlatform) !== null;
}
