/** POST /api/migrate/batches — start a batch migration.
 *  GET  /api/migrate/batches — list batches (paginated via ?page=&limit=).
 */
import { json } from "@sveltejs/kit";
import { listBatchesPaginated, startBatch } from "$lib/server/manager";
import { batchMigrationSchema, validateBody } from "$lib/server/schemas";
import { parseJsonBody, validateAuthAvailable } from "$lib/server/validate";
import { parsePaginationParams } from "$lib/types";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request }) => {
  const parsed = await parseJsonBody(request);
  if ("error" in parsed) {
    return json({ error: parsed.error }, { status: 400 });
  }

  const result = validateBody(batchMigrationSchema, parsed.data);
  if (!result.ok) {
    return json({ error: result.error }, { status: 400 });
  }
  const body = result.value;

  const authError = validateAuthAvailable(body);
  if (authError) {
    return json({ error: authError }, { status: 400 });
  }

  try {
    const batch = startBatch(body);
    return json(batch, { status: 201 });
  } catch (err) {
    // Over-cap requests queue (never throw), so a throw is an unexpected internal
    // failure: log it and return a generic 500 (not a stale 429, which would
    // wrongly signal a retryable rate limit).
    console.error("[api] POST /api/migrate/batches failed:", err);
    return json({ error: "Internal server error" }, { status: 500 });
  }
};

export const GET: RequestHandler = async ({ url }) => {
  return json(listBatchesPaginated(parsePaginationParams(url.searchParams)));
};
