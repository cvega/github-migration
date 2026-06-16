/**
 * GET /api/profile/enterprise/[id]/events — SSE stream of live enterprise
 * progress.
 *
 * Pushes a `progress` frame as orgs are enumerated and each child org settles,
 * and a terminal `done` frame when the enterprise run finishes. Mirrors the org
 * events stream: progress is ephemeral (the run and its children are the durable
 * state), so a reconnecting client just refetches the current snapshot.
 */
import { sseResponse } from "$lib/server/core/sse";
import { sendProfileEvent, subscribeProfile } from "$lib/server/profile/events";
import { getEnterpriseDetail } from "$lib/server/profile/service";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ params }) => {
  const detail = getEnterpriseDetail(params.id);
  if (!detail) {
    return new Response("Not found", { status: 404 });
  }

  return sseResponse((controller) => {
    const unsubscribe = subscribeProfile(params.id, controller);

    // Re-read the state AFTER subscribing to close the race window: if the run
    // went terminal between the initial read and subscribe(), its `done` would
    // have been missed. Emit it now and close so the client stops immediately.
    const state = getEnterpriseDetail(params.id)?.run.state ?? detail.run.state;
    if (state !== "running") {
      sendProfileEvent(controller, { type: "done", state });
      controller.close();
      unsubscribe();
      return () => {};
    }

    return unsubscribe;
  });
};
