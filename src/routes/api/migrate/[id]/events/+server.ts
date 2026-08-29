import { json } from "@sveltejs/kit";
import { isTerminalMigrationState } from "$lib/migration-state";
import {
  createBufferedSseController,
  parseSseLastEventId,
  sseResponse,
} from "$lib/server/core/sse";
import { getMigrationEventReplayWindow } from "$lib/server/migrate/database/events";
import { get, subscribe } from "$lib/server/migrate/manager";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ params, url, request }) => {
  const migration = get(params.id);
  if (!migration) return new Response("Not found", { status: 404 });
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
    const unsubscribe = subscribe(params.id, handoff.controller);
    if (afterId !== undefined) {
      const replay = getMigrationEventReplayWindow(params.id, afterId);
      for (const event of replay.events) {
        controller.enqueue(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      if (replay.stale) {
        controller.enqueue(
          `event: cursor-stale\ndata: ${JSON.stringify({ type: "cursor_stale", reason: replay.stale, requestedAfter: afterId, replayFrom: replay.replayFrom, highWater: replay.highWater })}\n\n`,
        );
      }
      if (handoff.activate(replay.highWater)) {
        unsubscribe();
        return null;
      }
    } else if (handoff.activate()) {
      unsubscribe();
      return null;
    }
    const state = get(params.id)?.state ?? migration.state;
    if (isTerminalMigrationState(state)) {
      controller.enqueue(`data: ${JSON.stringify({ type: "done", state })}\n\n`);
      controller.close();
      unsubscribe();
      return null;
    }
    return unsubscribe;
  });
};
