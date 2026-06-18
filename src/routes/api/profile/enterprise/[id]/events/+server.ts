/**
 * GET /api/profile/enterprise/[id]/events — SSE stream of live enterprise
 * progress.
 *
 * Pushes a `progress` frame as orgs are enumerated and each child org settles,
 * and a terminal `done` frame when the enterprise run finishes. Mirrors the org
 * events stream: progress is ephemeral (the run and its children are the durable
 * state), so a reconnecting client just refetches the current snapshot.
 */
import { createRunEventsRoute } from "$lib/server/profile/events-route";
import { getEnterpriseDetail } from "$lib/server/profile/service";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = createRunEventsRoute(
  (id) => getEnterpriseDetail(id)?.run.state ?? null,
);
