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
