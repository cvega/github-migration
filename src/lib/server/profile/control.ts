/**
 * In-memory pause coordination for profiling crawls.
 *
 * A running crawl is a background promise; to pause it cooperatively we set a
 * flag keyed by the run id, and the runner checks it at safe checkpoints
 * (between augment chunks and per-repo passes). When the flag is set the crawl
 * stops pulling new work and persists `state='paused'` with its progress intact,
 * so a later resume skips the repos it already finished.
 *
 * The registry is intentionally process-local and ephemeral: a pause request
 * only matters for a crawl running in *this* process. A server restart drops any
 * pending request — but the run is then interrupted anyway and is handled by the
 * startup resume path. Run ids are unique across org and enterprise runs, so a
 * single registry serves both.
 */
const pauseRequests = new Set<string>();

/** Request that the crawl for `runId` pause at its next safe checkpoint. */
export function requestPause(runId: string): void {
  pauseRequests.add(runId);
}

/** Whether a pause has been requested for `runId` (the runner's checkpoint read). */
export function isPauseRequested(runId: string): boolean {
  return pauseRequests.has(runId);
}

/**
 * Clear any pending pause request for `runId`. Called by the runner once it has
 * settled (so a too-late request can't linger) and by a resume before it
 * re-dispatches (so a stale flag can't immediately re-pause the fresh crawl).
 */
export function clearPause(runId: string): void {
  pauseRequests.delete(runId);
}
