/** GET    /api/migrate/batches/[id] — get batch detail (paginated migrations via ?page=&limit=).
 *  DELETE /api/migrate/batches/[id] — cancel all active migrations in the batch.
 */
import { json } from "@sveltejs/kit";
import { cancelBatch, getBatch, getBatchPaginated } from "$lib/server/manager";
import { parsePaginationParams } from "$lib/types";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, url }) => {
  const result = getBatchPaginated(params.id, parsePaginationParams(url.searchParams));
  if (!result) return json({ error: "Batch not found" }, { status: 404 });
  return json(result);
};

export const DELETE: RequestHandler = async ({ params }) => {
  const batch = getBatch(params.id);
  if (!batch) return json({ error: "Batch not found" }, { status: 404 });

  const cancelledCount = cancelBatch(params.id);
  return json({ status: "cancelled", cancelledCount });
};
