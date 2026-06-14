/**
 * GET /api/profile/[id]/events — SSE stream of live profiling progress.
 *
 * Pushes a `progress` frame as each repository is profiled and a terminal
 * `done` frame when the run settles, so the run-detail page can update without
 * polling. There's no event replay (profile progress is ephemeral — the run and
 * its repos are the durable state); a reconnecting client just refetches the
 * current snapshot.
 */
import { sseResponse } from "$lib/server/core/sse";
import { sendProfileEvent, subscribeProfile } from "$lib/server/profile/events";
import { getProfileDetail } from "$lib/server/profile/service";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ params }) => {
  const detail = getProfileDetail(params.id);
  if (!detail) {
    return new Response("Not found", { status: 404 });
  }

  return sseResponse((controller) => {
    const unsubscribe = subscribeProfile(params.id, controller);

    // Re-read the state AFTER subscribing to close the race window: if the run
    // went terminal between the initial read and subscribe(), its `done` would
    // have been missed. Emit it now and close so the client stops immediately.
    const state = getProfileDetail(params.id)?.run.state ?? detail.run.state;
    if (state !== "running") {
      sendProfileEvent(controller, { type: "done", state });
      controller.close();
      unsubscribe();
      return () => {};
    }

    return unsubscribe;
  });
};
