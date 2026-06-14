/** GET /api/migrate/migrations/[id]/events — SSE stream of migration events.
 *
 * Supports ?after=<eventId> to replay events since a given ID
 * (useful for reconnection).
 */

import { get, events as getEvents, subscribe } from "$lib/server/manager";
import { sseResponse } from "$lib/server/sse";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, url, request }) => {
  const migration = get(params.id);
  if (!migration) {
    return new Response("Not found", { status: 404 });
  }

  // Support both ?after= query param and standard SSE Last-Event-ID header.
  const afterParam = url.searchParams.get("after") ?? request.headers.get("Last-Event-ID");
  const parsedAfterId = afterParam ? parseInt(afterParam, 10) : undefined;
  if (afterParam && (parsedAfterId === undefined || Number.isNaN(parsedAfterId))) {
    return new Response('Invalid "after" / Last-Event-ID — must be a number', {
      status: 400,
    });
  }

  return sseResponse((controller) => {
    // Replay missed events on reconnect.
    if (parsedAfterId !== undefined) {
      const missed = getEvents(params.id, parsedAfterId);
      for (const event of missed) {
        const idLine = event.id != null ? `id: ${event.id}\n` : "";
        controller.enqueue(`${idLine}data: ${JSON.stringify(event)}\n\n`);
      }
    }

    // Subscribe to live events.
    const unsubscribe = subscribe(params.id, controller);

    // Re-read migration state AFTER subscribing to close the race window.
    // If the migration went terminal between the initial read and subscribe(),
    // the broadcast would have been missed. Checking again ensures we detect it.
    const freshMigration = get(params.id);
    const terminalState = freshMigration?.state ?? migration.state;
    if (["succeeded", "failed", "cancelled"].includes(terminalState)) {
      controller.enqueue(`data: ${JSON.stringify({ type: "done", state: terminalState })}\n\n`);
      controller.close();
      unsubscribe();
      return () => {};
    }

    return unsubscribe;
  });
};
