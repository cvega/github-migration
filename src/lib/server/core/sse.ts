/**
 * Server-Sent Events helper. Builds an SSE `Response` with the standard
 * event-stream headers and a 30s keepalive comment, and runs a caller-provided
 * `onStart` once the stream opens. `onStart` receives a text-frame controller;
 * frames are UTF-8 encoded for the HTTP adapter. It returns a cleanup function
 * (e.g. an unsubscribe) that runs when the client disconnects.
 *
 * Centralizes the boilerplate shared by the global and per-migration event
 * endpoints (keepalive interval, cleanup wiring, headers).
 */

import { hasActiveAdminSession } from "./auth/sessions";

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
 * @param onStart Runs when the stream opens, with a text-frame controller so
 *   callers can `enqueue` payloads and `close` the stream. Returns a cleanup fn
 *   (e.g. an unsubscribe) invoked on client disconnect or keepalive failure,
 *   or `null` when setup closes the stream synchronously.
 */
export function sseResponse(
  locals: App.Locals | undefined,
  onStart: (controller: ReadableStreamDefaultController<string>) => (() => void) | null,
): Response {
  let cleanup: (() => void) | null = null;
  let keepalive: ReturnType<typeof setInterval> | null = null;

  // An undefined hash denotes the explicitly unauthenticated workbench.
  const tokenHash = locals?.authEnabled ? (locals.sessionTokenHash ?? "") : undefined;
  function dispose() {
    if (keepalive) clearInterval(keepalive);
    keepalive = null;
    cleanup?.();
    cleanup = null;
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      cleanup = onStart({
        get desiredSize() {
          return controller.desiredSize;
        },
        enqueue(frame) {
          controller.enqueue(encoder.encode(frame));
        },
        close() {
          controller.close();
        },
        error(reason) {
          controller.error(reason);
        },
      });
      if (!cleanup) return;

      keepalive = setInterval(() => {
        try {
          if (tokenHash !== undefined && !hasActiveAdminSession(tokenHash)) {
            controller.enqueue(encoder.encode("event: session-ended\ndata: {}\n\n"));
            controller.close();
            dispose();
            return;
          }
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          controller.error(new Error("Stream unavailable"));
          dispose();
        }
      }, KEEPALIVE_INTERVAL_MS);
    },
    cancel: dispose,
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

export function parseSseLastEventId(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^\d+$/.test(value)) throw new Error("must be a non-negative integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id)) throw new Error("must be a safe integer");
  return id;
}

function frameId(frame: string): number | undefined {
  const match = /^id: (\d+)$/m.exec(frame);
  return match ? Number(match[1]) : undefined;
}

export function createBufferedSseController(target: ReadableStreamDefaultController<string>): {
  controller: ReadableStreamDefaultController<string>;
  activate: (highWater?: number) => boolean;
} {
  const buffered: string[] = [];
  let active = false;
  let closePending = false;

  const controller = {
    enqueue(frame: string) {
      if (active) target.enqueue(frame);
      else buffered.push(frame);
    },
    close() {
      if (active) target.close();
      else closePending = true;
    },
  } as ReadableStreamDefaultController<string>;

  return {
    controller,
    activate(highWater) {
      active = true;
      for (const frame of buffered) {
        const id = frameId(frame);
        if (id === undefined || highWater === undefined || id > highWater) target.enqueue(frame);
      }
      buffered.length = 0;
      if (closePending) target.close();
      return closePending;
    },
  };
}
