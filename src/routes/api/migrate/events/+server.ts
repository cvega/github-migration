/** GET /api/migrate/events — global SSE stream for ALL migration events (dashboard). */

import { subscribeGlobal } from "$lib/server/manager";
import { sseResponse } from "$lib/server/sse";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () => {
  return sseResponse((controller) => subscribeGlobal(controller));
};
