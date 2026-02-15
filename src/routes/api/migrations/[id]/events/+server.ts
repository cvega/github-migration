/** GET /api/migrations/[id]/events — SSE stream of migration events.
 *
 * Supports ?after=<eventId> to replay events since a given ID
 * (useful for reconnection).
 */
import type { RequestHandler } from "./$types";
import { subscribe, events as getEvents, get } from "$lib/server/manager";

export const GET: RequestHandler = async ({ params, url }) => {
  const migration = get(params.id);
  if (!migration) {
    return new Response("Not found", { status: 404 });
  }

  const afterId = url.searchParams.get("after");
  const parsedAfterId = afterId ? parseInt(afterId, 10) : undefined;
  if (afterId && (parsedAfterId === undefined || Number.isNaN(parsedAfterId))) {
    return new Response('Invalid "after" parameter — must be a number', {
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
          controller.enqueue(`data: ${JSON.stringify(event)}\n\n`);
        }
      }

      // Subscribe to live events.
      unsubscribe = subscribe(params.id, controller);

      // If the migration is already terminal, close after replay.
      if (["succeeded", "failed", "cancelled"].includes(migration.state)) {
        controller.enqueue(
          `data: ${JSON.stringify({ type: "done", state: migration.state })}\n\n`,
        );
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
