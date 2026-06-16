/** A single enterprise profiling run with its child organization runs. */
import { error } from "@sveltejs/kit";
import { getEnterpriseDetail } from "$lib/server/profile/service";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params }) => {
  const detail = getEnterpriseDetail(params.id);
  if (!detail) {
    error(404, "Enterprise run not found");
  }
  return detail;
};
