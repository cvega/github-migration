/** GET /api/migrations/[id]/events — SSE stream of migration events.
 *
 * Supports ?after=<eventId> to replay events since a given ID
 * (useful for reconnection).
 */

import { get, events as getEvents, subscribe } from "$lib/server/manager";
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

  let unsubscribe: (() => void) | null = null;
  let keepalive: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<string>({
    start(controller) {
      // Replay missed events on reconnect.
      if (parsedAfterId !== undefined) {
        const missed = getEvents(params.id, parsedAfterId);
        for (const event of missed) {
          const idLine = event.id != null ? `id: ${event.id}\n` : "";
          controller.enqueue(`${idLine}data: ${JSON.stringify(event)}\n\n`);
        }
      }

      // Subscribe to live events.
      unsubscribe = subscribe(params.id, controller);

      // Re-read migration state AFTER subscribing to close the race window.
      // If the migration went terminal between the initial read and subscribe(),
      // the broadcast would have been missed. Checking again ensures we detect it.
      const freshMigration = get(params.id);
      const terminalState = freshMigration?.state ?? migration.state;
      if (["succeeded", "failed", "cancelled"].includes(terminalState)) {
        controller.enqueue(`data: ${JSON.stringify({ type: "done", state: terminalState })}\n\n`);
        controller.close();
        unsubscribe();
        unsubscribe = null;
        return;
      }

      // Send keepalive comment every 30s to prevent proxy timeouts.
      keepalive = setInterval(() => {
        try {
          controller.enqueue(": keepalive\n\n");
        } catch {
          if (keepalive) clearInterval(keepalive);
          unsubscribe?.();
          unsubscribe = null;
          keepalive = null;
        }
      }, 30_000);
    },
    cancel() {
      if (keepalive) clearInterval(keepalive);
      unsubscribe?.();
      unsubscribe = null;
      keepalive = null;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
};
