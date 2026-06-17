/** A single profiling run with paginated per-repo results. */
import { error } from "@sveltejs/kit";
import { getProfileDetailPaginated } from "$lib/server/profile/service";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params, url }) => {
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "25"), 1), 100);
  const offset = Math.max(parseInt(url.searchParams.get("offset") ?? "0"), 0);

  const detail = getProfileDetailPaginated(params.id, limit, offset);
  if (!detail) {
    error(404, "Profile run not found");
  }
  return detail;
};
