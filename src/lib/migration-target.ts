import type { SourceProvider } from "$lib/source/types";
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

const SUPPORTED_TARGETS: Record<SourceProvider, readonly TargetPlatform[]> = {
  github: ["ghec"],
  gitlab: ["ghec", "ghes"],
  "bitbucket-server": ["ghec", "ghes"],
};

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
  return SUPPORTED_TARGETS[sourceProvider].includes(targetPlatform);
}
