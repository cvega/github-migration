/**
 * GET /api/profile/[id]/events — SSE stream of live profiling progress.
 *
 * Pushes a `progress` frame as each repository is profiled and a terminal
 * `done` frame when the run settles, so the run-detail page can update without
 * polling. There's no event replay (profile progress is ephemeral — the run and
 * its repos are the durable state); a reconnecting client just refetches the
 * current snapshot.
 */
import { createRunEventsRoute } from "$lib/server/profile/events-route";
import { getProfileDetail } from "$lib/server/profile/service";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = createRunEventsRoute(
  (id) => getProfileDetail(id)?.run.state ?? null,
);
