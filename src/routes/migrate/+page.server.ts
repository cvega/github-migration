import { existsSync } from "node:fs";
import { join } from "node:path";
import { parsePaginationParams } from "$lib/migrate/types";
import {
  listBatchesPaginated,
  listPaginated,
  searchBatchesPaginated,
  searchPaginated,
  stateCounts,
} from "$lib/server/migrate/manager";
import type { PageServerLoad } from "./$types";

const MAX_QUERY_LEN = 100;

function resolveLogoUrl(): string | null {
  for (const name of ["logo.svg", "logo.webp", "logo.png"]) {
    if (existsSync(join("static", "imgs", name))) return `/imgs/${name}`;
  }
  return null;
}

export const load: PageServerLoad = async ({ url }) => {
  const { page, limit } = parsePaginationParams(url.searchParams);
  const batchParams = new URLSearchParams({
    page: url.searchParams.get("bp") ?? "1",
    limit: "10",
  });
  const batchPage = parsePaginationParams(batchParams).page;
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, MAX_QUERY_LEN);

  if (q) {
    return {
      q,
      migrations: searchPaginated({ q, page, limit }),
      batches: searchBatchesPaginated({ q, page: batchPage, limit: 10 }),
      stateCounts: null,
      logoUrl: resolveLogoUrl(),
    };
  }

  return {
    q: "",
    migrations: listPaginated({ page, limit }),
    batches: listBatchesPaginated({ page: batchPage, limit: 10 }),
    stateCounts: stateCounts(),
    logoUrl: resolveLogoUrl(),
  };
};
