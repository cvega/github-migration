/** POST /api/migrate/batches/[id]/restart — restart all failed/cancelled migrations in a batch. */
import { json } from "@sveltejs/kit";
import { parseAuthenticatedBody } from "$lib/server/core/validate";
import { getBatch, restartBatch } from "$lib/server/migrate/manager";
import { restartSchema, validateBody } from "$lib/server/migrate/schemas";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ params, request }) => {
  const batch = getBatch(params.id);
  if (!batch) return json({ error: "Batch not found" }, { status: 404 });

  const parsed = await parseAuthenticatedBody(request, (d) => validateBody(restartSchema, d));
  if ("errorResponse" in parsed) return parsed.errorResponse;

  const summary = restartBatch(params.id, parsed.body);
  return json(summary);
};
