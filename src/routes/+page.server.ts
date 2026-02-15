import type { PageServerLoad } from "./$types";
import { listPaginated, listBatchesPaginated } from "$lib/server/manager";
import { DEFAULT_PAGE_SIZE } from "$lib/types";

export const load: PageServerLoad = async ({ url }) => {
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
  const batchPage = Math.max(
    1,
    parseInt(url.searchParams.get("bp") ?? "1", 10) || 1,
  );

  return {
    migrations: listPaginated({ page, limit }),
    batches: listBatchesPaginated({ page: batchPage, limit: 10 }),
  };
};
