/** POST /api/batches — start a batch migration.
 *  GET  /api/batches — list batches (paginated via ?page=&limit=).
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
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: message }, { status: 429 });
  }
};

export const GET: RequestHandler = async ({ url }) => {
  return json(listBatchesPaginated(parsePaginationParams(url.searchParams)));
};
