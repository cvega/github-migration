import type { PageServerLoad } from "./$types";
import { getBatchPaginated } from "$lib/server/manager";
import { error } from "@sveltejs/kit";
import { DEFAULT_PAGE_SIZE } from "$lib/types";

export const load: PageServerLoad = async ({ params, url }) => {
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
  if (!result) throw error(404, "Batch not found");
  return { batch: result.summary, migrations: result.migrations };
};
