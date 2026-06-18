/**
 * SSE route factory for live profile/enterprise run progress.
 *
 * The org and enterprise events endpoints are identical apart from how they look
 * up a run's current state, so this builds the GET handler from that one lookup.
 * The stream pushes `progress`/`done` frames published to the run's id; there's
 * no replay (progress is ephemeral — the run and its rows are the durable state),
 * so a reconnecting client just refetches the current snapshot.
 */
import { sseResponse } from "$lib/server/core/sse";
import { sendProfileEvent, subscribeProfile } from "./events";
import type { ProfileRunState } from "./types";

/**
 * Build a GET handler that streams a run's live events over SSE.
 *
 * @param resolveState Returns the run's current lifecycle state, or null when no
 *   such run exists (→ 404). It's read once up front and again immediately after
 *   subscribing, to close the race where the run goes terminal between the two —
 *   in which case the handler emits a final `done` and closes.
 */
export function createRunEventsRoute(
  resolveState: (id: string) => ProfileRunState | null,
): (event: { params: { id: string } }) => Response {
  return ({ params }) => {
    const state = resolveState(params.id);
    if (state === null) {
      return new Response("Not found", { status: 404 });
    }

    return sseResponse((controller) => {
      const unsubscribe = subscribeProfile(params.id, controller);

      // Re-read the state AFTER subscribing to close the race window: if the run
      // went terminal between the initial read and subscribe(), its `done` would
      // have been missed. Emit it now and close so the client stops immediately.
      const current = resolveState(params.id) ?? state;
      if (current !== "running") {
        sendProfileEvent(controller, { type: "done", state: current });
        controller.close();
        unsubscribe();
        return () => {};
      }

      return unsubscribe;
    });
  };
}
