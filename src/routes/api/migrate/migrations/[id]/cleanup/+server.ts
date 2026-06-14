/** POST /api/migrate/migrations/[id]/cleanup — guarded rename/delete of a target repo.
 *  GET  /api/migrate/migrations/[id]/cleanup?action=rename|delete — preview the gate
 *       checklist for the confirmation modal (read-only, never acts).
 */
import { json } from "@sveltejs/kit";
import { executeCleanup, previewCleanup } from "$lib/server/migrate/cleanup-service";
import type { RequestHandler } from "./$types";

function parseAction(value: string | null | undefined): "rename" | "delete" | null {
  return value === "rename" || value === "delete" ? value : null;
}

export const GET: RequestHandler = async ({ params, url }) => {
  const action = parseAction(url.searchParams.get("action"));
  if (!action) {
    return json({ error: "Query param 'action' must be 'rename' or 'delete'" }, { status: 400 });
  }
  const preview = await previewCleanup(params.id, action);
  if (!preview) return json({ error: "Migration not found" }, { status: 404 });
  return json(preview);
};

export const POST: RequestHandler = async ({ params, request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON in request body" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return json({ error: "Request body must be a JSON object" }, { status: 400 });
  }
  const { action: rawAction, confirmation } = body as Record<string, unknown>;
  const action = parseAction(typeof rawAction === "string" ? rawAction : null);
  if (!action) {
    return json({ error: "Field 'action' must be 'rename' or 'delete'" }, { status: 400 });
  }
  if (typeof confirmation !== "string") {
    return json({ error: "Field 'confirmation' is required" }, { status: 400 });
  }

  const result = await executeCleanup(params.id, action, confirmation);
  if (result.ok) return json(result);

  // Map refusal reasons to status codes: not-found → 404, everything else is a
  // precondition/permission failure the caller can't retry as-is → 409.
  const status = result.reason === "migration-not-found" ? 404 : 409;
  return json({ error: result.detail, reason: result.reason }, { status });
};
