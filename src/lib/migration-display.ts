/**
 * Shared presentation helpers for migration state — colors, icons, and the
 * source-platform check — used across the dashboard, cards, and detail pages
 * so the visual language stays consistent in one place.
 */
import type { IconName } from "@primer/octicons";
import type { MigrationState } from "$lib/types";

/** Tailwind background+text classes for a migration state pill. */
export const STATE_STYLES: Record<MigrationState, string> = {
  queued: "bg-violet-500/15 text-violet-400",
  pending: "bg-yellow-500/15 text-yellow-400",
  running: "bg-blue-500/15 text-blue-400",
  succeeded: "bg-green-600/15 text-green-400",
  failed: "bg-red-500/15 text-red-400",
  cancelled: "bg-gray-500/15 text-gray-400",
};

/** Octicon name for a migration state. */
export const STATE_ICONS: Record<MigrationState, IconName> = {
  queued: "hourglass",
  pending: "clock",
  running: "sync",
  succeeded: "check-circle",
  failed: "x-circle-fill",
  cancelled: "skip",
};

/** States that represent in-flight work (not yet in a terminal state). */
export const ACTIVE_STATES: ReadonlySet<MigrationState> = new Set(["queued", "pending", "running"]);

/** True when a migration is still in flight (queued, pending, or running). */
export function isActiveState(state: MigrationState): boolean {
  return ACTIVE_STATES.has(state);
}

/** True when the source API URL points at GitHub.com / GHEC (vs a GHES host). */
export function isGitHubCloud(apiUrl: string | null | undefined): boolean {
  return !!apiUrl && apiUrl.includes("api.github.com");
}

/** Short platform label for a migration's source API URL. */
export function sourcePlatform(apiUrl: string | null | undefined): "GHES" | "GHEC" {
  return isGitHubCloud(apiUrl) ? "GHEC" : "GHES";
}
