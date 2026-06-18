/** GET /api/profile/[id] — a profiling run and its per-repo results (paginated). */
import { json } from "@sveltejs/kit";
import { getProfileDetail, getProfileDetailPaginated } from "$lib/server/profile/service";
import { parseLimitOffset } from "$lib/types";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, url }) => {
  const { limit, offset } = parseLimitOffset(url.searchParams);

  // If limit/offset are provided, use pagination. Otherwise fall back to full
  // detail (for backward compat with existing clients).
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
