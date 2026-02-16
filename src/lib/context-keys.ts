/**
 * Typed Svelte context keys — prevents typos and enables refactoring.
 */
import type { GitHubStatus } from "$lib/types";

/** Context key for live GitHub platform status. */
export const GH_STATUS_KEY = Symbol("ghStatus");

/** Shape of the ghStatus context value (reactive getter). */
export interface GhStatusContext {
  readonly value: GitHubStatus;
}

/** Context key for live auth pill data (rate limits, mode, active count). */
export const AUTH_PILL_KEY = Symbol("authPill");

export interface AuthPillContext {
  readonly sourceApp: boolean;
  readonly targetApp: boolean;
  readonly sourceRateText: string;
  readonly targetRateText: string;
  readonly sourceRatePct: number;
  readonly targetRatePct: number;
  readonly migrating: boolean;
}
