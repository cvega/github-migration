import { json } from "@sveltejs/kit";
import { requireAdminIfAuthEnabled } from "$lib/server/core/auth/authorization";
import {
  createBufferedSseController,
  parseSseLastEventId,
  sseResponse,
} from "$lib/server/core/sse";
import { getGlobalEventReplayWindow } from "$lib/server/migrate/database/events";
import { subscribeGlobal } from "$lib/server/migrate/manager";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ url, request, locals }) => {
  requireAdminIfAuthEnabled(locals);
  let afterId: number | undefined;
  try {
    afterId = parseSseLastEventId(
      url.searchParams.get("after") ?? request.headers.get("Last-Event-ID"),
    );
  } catch {
    return json(
      { error: 'Invalid "after" / Last-Event-ID - must be a non-negative integer' },
      { status: 400 },
    );
  }
  return sseResponse((controller) => {
    const handoff = createBufferedSseController(controller);
    const unsubscribe = subscribeGlobal(handoff.controller);
    if (afterId !== undefined) {
      const replay = getGlobalEventReplayWindow(afterId);
      for (const event of replay.events) {
        controller.enqueue(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      if (replay.stale) {
        controller.enqueue(
          `event: cursor-stale\ndata: ${JSON.stringify({ type: "cursor_stale", reason: replay.stale, requestedAfter: afterId, replayFrom: replay.replayFrom, highWater: replay.highWater })}\n\n`,
        );
      }
      handoff.activate(replay.highWater);
    } else {
      handoff.activate();
    }
    return unsubscribe;
  });
};
