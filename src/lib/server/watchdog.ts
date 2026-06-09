/**
 * Stall-watchdog configuration and pure evaluation helpers.
 *
 * The bug this guards against: a GHEC migration occasionally hangs in an
 * in-progress state for hours without ever failing, tying up one of the 10
 * concurrent migration slots. The watchdog detects a migration that has
 * "started migrating" (GHEC reports IN_PROGRESS) but has made zero forward
 * progress for a configured window, then aborts and restarts it.
 *
 * Large repositories are NEVER auto-restarted — they legitimately take a long
 * time — where "large" is a composite of disk size, commits, issues, and pull
 * requests. All thresholds are operator-configurable via environment variables.
 */
import { env } from "$env/dynamic/private";
import type { Counts, Phase } from "$lib/types";

export interface WatchdogConfig {
  enabled: boolean;
  /** No-progress window before a migration is considered stalled (ms). */
  stallMs: number;
  /** Maximum automatic restarts before giving up and marking the migration failed. */
  maxRestarts: number;
  /** Disk-size cap (KB) — at or above this a repo is "large". */
  maxSizeKb: number;
  /** Commit-count cap — at or above this a repo is "large". */
  maxCommits: number;
  /** Issue-count cap — at or above this a repo is "large". */
  maxIssues: number;
  /** Pull-request-count cap — at or above this a repo is "large". */
  maxPrs: number;
}

/** Phases where the migration has started importing on GHEC (state IN_PROGRESS). */
export const ACTIVE_IMPORT_PHASES: ReadonlySet<Phase> = new Set<Phase>([
  "EXPORTING",
  "IMPORTING_GIT",
  "IMPORTING_METADATA",
]);

function num(value: string | undefined, fallback: number): number {
  const n = value != null && value !== "" ? Number(value) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === "") return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

/** Read watchdog thresholds from the environment, applying safe defaults. */
export function loadWatchdogConfig(): WatchdogConfig {
  return {
    enabled: bool(env.WATCHDOG_ENABLED, true),
    stallMs: num(env.WATCHDOG_STALL_MINUTES, 30) * 60_000,
    maxRestarts: num(env.WATCHDOG_MAX_RESTARTS, 1),
    maxSizeKb: num(env.WATCHDOG_MAX_SIZE_MB, 100) * 1024,
    maxCommits: num(env.WATCHDOG_MAX_COMMITS, 50_000),
    maxIssues: num(env.WATCHDOG_MAX_ISSUES, 5_000),
    maxPrs: num(env.WATCHDOG_MAX_PRS, 5_000),
  };
}

/**
 * A repo is "large" — and therefore never auto-restarted — when ANY dimension
 * (disk size, commits, issues, or PRs) meets or exceeds its configured cap.
 * Unknown values (null) never count toward "large".
 */
export function isLargeRepo(
  cfg: WatchdogConfig,
  repo: { sizeKb: number | null; counts: Counts | null },
): boolean {
  if (repo.sizeKb != null && repo.sizeKb >= cfg.maxSizeKb) return true;
  const c = repo.counts;
  if (c) {
    if (c.commits >= cfg.maxCommits) return true;
    if (c.issues >= cfg.maxIssues) return true;
    if (c.pullRequests >= cfg.maxPrs) return true;
  }
  return false;
}

/**
 * A monotonically-increasing "progress signal" — any growth between polls
 * means the migration is making forward progress (so it is NOT stalled).
 */
export function progressSignal(repoExists: boolean, counts: Counts): number {
  return (
    (repoExists ? 1 : 0) +
    counts.commits +
    counts.branches +
    counts.tags +
    counts.issues +
    counts.pullRequests +
    counts.releases
  );
}
