import { error } from "@sveltejs/kit";
import { getBatchPaginated } from "$lib/server/manager";
import { parsePaginationParams } from "$lib/types";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params, url }) => {
  const result = getBatchPaginated(params.id, parsePaginationParams(url.searchParams));
  if (!result) throw error(404, "Batch not found");
  return { batch: result.summary, migrations: result.migrations };
};
