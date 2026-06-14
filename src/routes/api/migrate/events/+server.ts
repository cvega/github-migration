/** GET /api/migrate/events — global SSE stream for ALL migration events (dashboard). */

import { sseResponse } from "$lib/server/core/sse";
import { subscribeGlobal } from "$lib/server/manager";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () => {
  return sseResponse((controller) => subscribeGlobal(controller));
};
