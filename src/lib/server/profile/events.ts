import type { SourceInventoryProgress } from "$lib/source/inventory";
import type { ProfilePhase, ProfileRunState } from "./types";

export type ProfileSseEvent =
  | { type: "progress"; profiled: number; total: number; repo: string; phase: ProfilePhase }
  | ({ type: "inventory-progress" } & SourceInventoryProgress)
  | { type: "done"; state: ProfileRunState };

const subscribers = new Map<string, Set<ReadableStreamDefaultController<string>>>();

function encode(event: ProfileSseEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export function sendProfileEvent(
  controller: ReadableStreamDefaultController<string>,
  event: ProfileSseEvent,
): void {
  controller.enqueue(encode(event));
}

export function publishProfileEvent(runId: string, event: ProfileSseEvent): void {
  const runSubscribers = subscribers.get(runId);
  if (!runSubscribers) return;
  const data = encode(event);
  for (const controller of runSubscribers) {
    try {
      controller.enqueue(data);
    } catch {
      runSubscribers.delete(controller);
    }
  }
  if (runSubscribers.size === 0) subscribers.delete(runId);
}

export function subscribeProfile(
  runId: string,
  controller: ReadableStreamDefaultController<string>,
): () => void {
  let runSubscribers = subscribers.get(runId);
  if (!runSubscribers) {
    runSubscribers = new Set();
    subscribers.set(runId, runSubscribers);
  }
  runSubscribers.add(controller);
  return () => {
    subscribers.get(runId)?.delete(controller);
    if (subscribers.get(runId)?.size === 0) subscribers.delete(runId);
  };
}
