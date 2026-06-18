/** POST /api/migrate/migrations/[id]/restart — restart a failed or cancelled migration. */
import { json } from "@sveltejs/kit";
import { parseAuthenticatedBody } from "$lib/server/core/validate";
import { restart } from "$lib/server/migrate/manager";
import { restartSchema, validateBody } from "$lib/server/migrate/schemas";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ params, request }) => {
  const parsed = await parseAuthenticatedBody(request, (d) => validateBody(restartSchema, d));
  if ("errorResponse" in parsed) return parsed.errorResponse;

  try {
    const migration = restart(params.id, parsed.body);
    return json(migration);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // "not found" / "Cannot restart" are intentional, safe domain messages.
    if (message.includes("not found")) {
      return json({ error: message }, { status: 404 });
    }
    if (message.includes("Cannot restart")) {
      return json({ error: message }, { status: 409 });
    }
    // Anything else is unexpected: log server-side, return a generic message.
    console.error("[api] POST /api/migrate/migrations/[id]/restart failed:", err);
    return json({ error: "Internal server error" }, { status: 500 });
  }
};
