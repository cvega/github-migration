/**
 * Profile SSE bus — an in-memory pub/sub that fans live run progress out to the
 * stream controllers of clients watching a run-detail page.
 *
 * Unlike the migrate domain, profile progress is ephemeral: the durable state
 * lives in `profile_runs` / `profile_repos`, so there's nothing to persist or
 * replay here. The bus just nudges connected clients (keyed by run id) to
 * refetch, and signals a terminal `done` so they can stop streaming.
 */
import type { ProfilePhase, ProfileRunState } from "./types";

/** An event pushed to a run's subscribers. */
export type ProfileSseEvent =
  | { type: "progress"; profiled: number; total: number; repo: string; phase: ProfilePhase }
  | { type: "done"; state: ProfileRunState };

/** Live stream controllers, keyed by run id. */
const subscribers = new Map<string, Set<ReadableStreamDefaultController<string>>>();

/** Encode an event as an SSE `data:` frame. */
function encode(event: ProfileSseEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** Enqueue one event to a single controller (e.g. the initial terminal flush). */
export function sendProfileEvent(
  controller: ReadableStreamDefaultController<string>,
  event: ProfileSseEvent,
): void {
  controller.enqueue(encode(event));
}

/** Broadcast an event to every subscriber of a run; drops dead controllers. */
export function publishProfileEvent(runId: string, event: ProfileSseEvent): void {
  const subs = subscribers.get(runId);
  if (!subs) return;
  const data = encode(event);
  for (const controller of subs) {
    try {
      controller.enqueue(data);
    } catch {
      subs.delete(controller);
    }
  }
}

/** Subscribe a stream controller to a run's events; returns an unsubscribe fn. */
export function subscribeProfile(
  runId: string,
  controller: ReadableStreamDefaultController<string>,
): () => void {
  let subs = subscribers.get(runId);
  if (!subs) {
    subs = new Set();
    subscribers.set(runId, subs);
  }
  subs.add(controller);

  return () => {
    subscribers.get(runId)?.delete(controller);
    if (subscribers.get(runId)?.size === 0) {
      subscribers.delete(runId);
    }
  };
}
