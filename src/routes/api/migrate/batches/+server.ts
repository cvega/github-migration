/** POST /api/migrate/batches — start a batch migration.
 *  GET  /api/migrate/batches — list batches (paginated via ?page=&limit=).
 */
import { json } from "@sveltejs/kit";
import { parseAuthenticatedBody } from "$lib/server/core/validate";
import { listBatchesPaginated, startBatch } from "$lib/server/migrate/manager";
import { batchMigrationSchema, validateBody } from "$lib/server/migrate/schemas";
import { parsePaginationParams } from "$lib/types";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request }) => {
  const parsed = await parseAuthenticatedBody(request, (d) =>
    validateBody(batchMigrationSchema, d),
  );
  if ("errorResponse" in parsed) return parsed.errorResponse;

  try {
    const batch = startBatch(parsed.body);
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
