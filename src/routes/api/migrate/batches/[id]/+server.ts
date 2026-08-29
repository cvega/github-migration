import { json } from "@sveltejs/kit";
import { parsePaginationParams } from "$lib/migrate/types";
import { cancelBatch, getBatch, getBatchPaginated } from "$lib/server/migrate/manager";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ params, url }) => {
  const batch = getBatchPaginated(params.id, parsePaginationParams(url.searchParams));
  return batch ? json(batch) : json({ error: "Batch not found" }, { status: 404 });
};

export const DELETE: RequestHandler = ({ params }) => {
  if (!getBatch(params.id)) return json({ error: "Batch not found" }, { status: 404 });
  return json({ cancelledCount: cancelBatch(params.id) });
};
