/** GET    /api/batches/[id] — get batch detail (paginated migrations via ?page=&limit=).
 *  DELETE /api/batches/[id] — cancel all active migrations in the batch.
 */
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getBatch, getBatchPaginated, cancelBatch } from "$lib/server/manager";
import { DEFAULT_PAGE_SIZE } from "$lib/types";

export const GET: RequestHandler = async ({ params, url }) => {
  const page = Math.max(
    1,
    parseInt(url.searchParams.get("page") ?? "1", 10) || 1,
  );
  const limit = Math.min(
    100,
    Math.max(
      1,
      parseInt(
        url.searchParams.get("limit") ?? String(DEFAULT_PAGE_SIZE),
        10,
      ) || DEFAULT_PAGE_SIZE,
    ),
  );
  const result = getBatchPaginated(params.id, { page, limit });
  if (!result) return json({ error: "Batch not found" }, { status: 404 });
  return json(result);
};

export const DELETE: RequestHandler = async ({ params }) => {
  const batch = getBatch(params.id);
  if (!batch) return json({ error: "Batch not found" }, { status: 404 });

  const cancelledCount = cancelBatch(params.id);
  return json({ status: "cancelled", cancelledCount });
};
