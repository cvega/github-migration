/**
 * Profile SSE bus — an in-memory pub/sub that fans live run progress out to the
 * stream controllers of clients watching a run-detail page.
 *
 * Unlike the migrate domain, profile progress is ephemeral: the durable state
 * lives in `profile_runs` / `profile_repos`, so there's nothing to persist or
 * replay here. The bus just nudges connected clients (keyed by run id) to
 * refetch, and signals a terminal `done` so they can stop streaming.
 */
import type { EnterprisePhase, ProfilePhase, ProfileRunState } from "./types";

/** An event pushed to an org run's subscribers. */
export type ProfileSseEvent =
  | { type: "progress"; profiled: number; total: number; repo: string; phase: ProfilePhase }
  | { type: "done"; state: ProfileRunState };

/** An event pushed to an enterprise run's subscribers. */
export type EnterpriseSseEvent =
  | {
      type: "progress";
      phase: EnterprisePhase;
      totalOrgs: number;
      profiledOrgs: number;
      org: string;
    }
  | { type: "done"; state: ProfileRunState };

/** Live stream controllers, keyed by run id (org or enterprise — ids are unique). */
const subscribers = new Map<string, Set<ReadableStreamDefaultController<string>>>();

/** Encode an event as an SSE `data:` frame. */
function encode(event: ProfileSseEvent | EnterpriseSseEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** Enqueue one event to a single controller (e.g. the initial terminal flush). */
export function sendProfileEvent(
  controller: ReadableStreamDefaultController<string>,
  event: ProfileSseEvent | EnterpriseSseEvent,
): void {
  controller.enqueue(encode(event));
}

/** Broadcast an event to every subscriber of an id; drops dead controllers. */
function broadcast(id: string, event: ProfileSseEvent | EnterpriseSseEvent): void {
  const subs = subscribers.get(id);
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

/** Broadcast an event to every subscriber of an org run. */
export function publishProfileEvent(runId: string, event: ProfileSseEvent): void {
  broadcast(runId, event);
}

/** Broadcast an event to every subscriber of an enterprise run. */
export function publishEnterpriseEvent(runId: string, event: EnterpriseSseEvent): void {
  broadcast(runId, event);
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
