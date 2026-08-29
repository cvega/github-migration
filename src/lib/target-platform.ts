export const TARGET_PLATFORMS = ["ghec", "ghes"] as const;

export type TargetPlatform = (typeof TARGET_PLATFORMS)[number];
