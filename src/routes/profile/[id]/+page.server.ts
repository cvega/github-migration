/** A single profiling run with paginated per-repo results. */
import { error } from "@sveltejs/kit";
import { getProfileDetailPaginated } from "$lib/server/profile/service";
import { parseLimitOffset } from "$lib/types";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params, url }) => {
  const { limit, offset } = parseLimitOffset(url.searchParams);

  const detail = getProfileDetailPaginated(params.id, limit, offset);
  if (!detail) {
    error(404, "Profile run not found");
  }
  return detail;
};
