/**
 * Shared presentation helpers for migration state — colors, icons, and the
 * source-platform check — used across the dashboard, cards, and detail pages
 * so the visual language stays consistent in one place.
 */
import type { UsedIconName as IconName } from "$lib/icons.generated";
import type { MigrationState } from "$lib/migrate/types";
import { getGitHubSourcePlatform } from "$lib/source-provider";

/** User-facing label for a persisted migration state. */
export const STATE_LABELS: Record<MigrationState, string> = {
  queued: "Waiting",
  pending: "Starting",
  running: "Running",
  cancelling: "Stopping",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
  reconciliation_required: "Needs review",
};

/** Tailwind background+text classes for a migration state pill. */
export const STATE_STYLES: Record<MigrationState, string> = {
  queued: "bg-violet-500/15 text-violet-400",
  pending: "bg-yellow-500/15 text-yellow-400",
  running: "bg-blue-500/15 text-blue-400",
  cancelling: "bg-yellow-500/15 text-yellow-300",
  succeeded: "bg-green-600/15 text-green-400",
  failed: "bg-red-500/15 text-red-400",
  cancelled: "bg-gray-500/15 text-gray-400",
  reconciliation_required: "bg-orange-500/15 text-orange-300",
};

/** Octicon name for a migration state. */
export const STATE_ICONS: Record<MigrationState, IconName> = {
  queued: "hourglass",
  pending: "clock",
  running: "sync",
  cancelling: "stopwatch",
  succeeded: "check-circle",
  failed: "x-circle-fill",
  cancelled: "skip",
  reconciliation_required: "alert",
};

/**
 * True when the source API URL points at GitHub Enterprise Cloud rather than a
 * GHES instance. GHEC lives on github.com (incl. api.github.com) and on
 * data-residency tenants under *.ghe.com; everything else is GHES.
 */
export function isGitHubCloud(apiUrl: string | null | undefined): boolean {
  return getGitHubSourcePlatform(apiUrl) === "ghec";
}

/** Short platform label for a migration's source API URL. */
export function sourcePlatform(apiUrl: string | null | undefined): "GHES" | "GHEC" {
  return isGitHubCloud(apiUrl) ? "GHEC" : "GHES";
}
