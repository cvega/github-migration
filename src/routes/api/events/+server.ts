/** GET /api/events — global SSE stream for ALL migration events (dashboard). */

import { subscribeGlobal } from "$lib/server/manager";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () => {
  let unsubscribe: (() => void) | null = null;
  let keepalive: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<string>({
    start(controller) {
      unsubscribe = subscribeGlobal(controller);

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
