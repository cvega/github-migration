/** POST /api/batches/[id]/restart — restart all failed/cancelled migrations in a batch. */
import { json } from "@sveltejs/kit";
import { getBatch, restartBatch } from "$lib/server/manager";
import {
  narrowBody,
  parseJsonBody,
  validateAuthAvailable,
  validateCommonFields,
} from "$lib/server/validate";
import type { RestartMigrationRequest } from "$lib/types";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ params, request }) => {
  const batch = getBatch(params.id);
  if (!batch) return json({ error: "Batch not found" }, { status: 404 });

  const parsed = await parseJsonBody(request);
  if ("error" in parsed) {
    return json({ error: parsed.error }, { status: 400 });
  }
  const body = narrowBody<RestartMigrationRequest>(parsed.data);

  const validationError = validateCommonFields(parsed.data);
  if (validationError) {
    return json({ error: validationError }, { status: 400 });
  }

  const authError = validateAuthAvailable(body);
  if (authError) {
    return json({ error: authError }, { status: 400 });
  }

  const result = restartBatch(params.id, body);
  return json(result);
};
