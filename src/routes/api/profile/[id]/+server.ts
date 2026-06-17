/** GET /api/profile/[id] — a profiling run and its per-repo results (paginated). */
import { json } from "@sveltejs/kit";
import { getProfileDetail, getProfileDetailPaginated } from "$lib/server/profile/service";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, url }) => {
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "25"), 1), 100);
  const offset = Math.max(parseInt(url.searchParams.get("offset") ?? "0"), 0);

  // If both limit and offset are provided (or just limit=anything), use pagination.
  // Otherwise, fall back to full detail (for backward compat with existing clients).
  const usePagination = url.searchParams.has("limit") || url.searchParams.has("offset");

  if (usePagination) {
    const detail = getProfileDetailPaginated(params.id, limit, offset);
    if (!detail) {
      return json({ error: "Profile run not found" }, { status: 404 });
    }
    return json(detail);
  }

  const detail = getProfileDetail(params.id);
  if (!detail) {
    return json({ error: "Profile run not found" }, { status: 404 });
  }
  return json(detail);
};
