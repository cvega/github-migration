import { json } from "@sveltejs/kit";
import { isTerminalMigrationState } from "$lib/migration-state";
import { getVisibleDetail } from "$lib/server/application/self-service/visible-events";
import { hasActiveAdminSession } from "$lib/server/core/auth/sessions";
import {
  createBufferedSseController,
  parseSseLastEventId,
  sseResponse,
} from "$lib/server/core/sse";
import {
  eventDownloadPages,
  getMigrationEventReplayWindow,
} from "$lib/server/migrate/database/events";
import { get, subscribe } from "$lib/server/migrate/manager";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ params, url, request, locals }) => {
  if (locals?.user?.role === "operator") {
    const detail = getVisibleDetail(locals.user.id, params.id);
    if (!detail) return new Response("Not found", { status: 404 });
    const headers = { "Cache-Control": "no-store" };
    if (url.searchParams.get("download") !== "1")
      return json({ events: detail.events }, { headers });
    return new Response(detail.events.map((e) => `${JSON.stringify(e)}\n`).join(""), {
      headers: {
        ...headers,
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Content-Disposition": 'attachment; filename="recent-migration-events.ndjson"',
      },
    });
  }
  const migration = get(params.id);
  if (!migration) return new Response("Not found", { status: 404 });
  if (url.searchParams.get("download") === "1") {
    const tokenHash = locals?.authEnabled ? (locals.sessionTokenHash ?? "") : undefined;
    const pages = eventDownloadPages(migration.id);
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (tokenHash !== undefined && !hasActiveAdminSession(tokenHash)) {
              controller.close();
              return;
            }
            const page = pages.next();
            if (page.done) controller.close();
            else
              controller.enqueue(
                encoder.encode(page.value.map((event) => `${JSON.stringify(event)}\n`).join("")),
              );
          },
        },
        // Check the session when the consumer requests a page.
        { highWaterMark: 0 },
      ),
      {
        headers: {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Content-Disposition": `attachment; filename="migration-${migration.id.replace(/[^a-zA-Z0-9_-]/g, "_")}-events.ndjson"`,
          "Cache-Control": "no-store",
        },
      },
    );
  }
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
  return sseResponse(locals, (controller) => {
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
