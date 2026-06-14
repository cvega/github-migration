/** POST /api/migrate/migrations/[id]/restart — restart a failed or cancelled migration. */
import { json } from "@sveltejs/kit";
import { parseJsonBody, validateAuthAvailable } from "$lib/server/core/validate";
import { restart } from "$lib/server/manager";
import { restartSchema, validateBody } from "$lib/server/schemas";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ params, request }) => {
  const parsed = await parseJsonBody(request);
  if ("error" in parsed) {
    return json({ error: parsed.error }, { status: 400 });
  }

  const result = validateBody(restartSchema, parsed.data);
  if (!result.ok) {
    return json({ error: result.error }, { status: 400 });
  }
  const body = result.value;

  // Auth check: need at least one auth method per side.
  const authError = validateAuthAvailable(body);
  if (authError) {
    return json({ error: authError }, { status: 400 });
  }

  try {
    const migration = restart(params.id, body);
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
