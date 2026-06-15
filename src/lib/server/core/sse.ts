/**
 * Server-Sent Events helper. Builds an SSE `Response` with the standard
 * event-stream headers and a 30s keepalive comment, and runs a caller-provided
 * `onStart` once the stream opens. `onStart` receives the raw stream controller
 * and returns a cleanup function (e.g. an unsubscribe) that runs when the client
 * disconnects.
 *
 * Centralizes the boilerplate shared by the global and per-migration event
 * endpoints (keepalive interval, cleanup wiring, headers).
 */

const KEEPALIVE_INTERVAL_MS = 30_000;

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  // Disable proxy response buffering (nginx and similar). Without this, a proxy
  // buffers the event stream and can close it as "idle" or time the upstream out
  // — surfacing as a 502 on the SSE endpoint. nginx honors this header the same
  // way as `proxy_buffering off;`.
  "X-Accel-Buffering": "no",
} as const;

/**
 * @param onStart Runs when the stream opens, with the raw stream controller so
 *   callers can `enqueue` payloads and `close` the stream. Returns a cleanup fn
 *   (e.g. an unsubscribe) invoked on client disconnect or keepalive failure.
 *   If `onStart` closes the stream itself, return a no-op cleanup.
 */
export function sseResponse(
  onStart: (controller: ReadableStreamDefaultController<string>) => () => void,
): Response {
  let cleanup: (() => void) | null = null;
  let keepalive: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<string>({
    start(controller) {
      cleanup = onStart(controller);

      keepalive = setInterval(() => {
        try {
          controller.enqueue(": keepalive\n\n");
        } catch {
          if (keepalive) clearInterval(keepalive);
          keepalive = null;
          cleanup?.();
          cleanup = null;
        }
      }, KEEPALIVE_INTERVAL_MS);
    },
    cancel() {
      if (keepalive) clearInterval(keepalive);
      keepalive = null;
      cleanup?.();
      cleanup = null;
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
