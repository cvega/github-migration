/** POST /api/migrate/batches/[id]/restart — restart all failed/cancelled migrations in a batch. */
import { json } from "@sveltejs/kit";
import { getBatch, restartBatch } from "$lib/server/manager";
import { restartSchema, validateBody } from "$lib/server/schemas";
import { parseJsonBody, validateAuthAvailable } from "$lib/server/validate";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ params, request }) => {
  const batch = getBatch(params.id);
  if (!batch) return json({ error: "Batch not found" }, { status: 404 });

  const parsed = await parseJsonBody(request);
  if ("error" in parsed) {
    return json({ error: parsed.error }, { status: 400 });
  }

  const result = validateBody(restartSchema, parsed.data);
  if (!result.ok) {
    return json({ error: result.error }, { status: 400 });
  }
  const body = result.value;

  const authError = validateAuthAvailable(body);
  if (authError) {
    return json({ error: authError }, { status: 400 });
  }

  const summary = restartBatch(params.id, body);
  return json(summary);
};
