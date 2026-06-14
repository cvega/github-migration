/** A single profiling run with its per-repo readiness results. */
import { error } from "@sveltejs/kit";
import { getProfileDetail } from "$lib/server/profile/service";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params }) => {
  const detail = getProfileDetail(params.id);
  if (!detail) {
    error(404, "Profile run not found");
  }
  return detail;
};
