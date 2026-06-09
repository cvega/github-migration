import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  listBatchesPaginated,
  listPaginated,
  searchBatchesPaginated,
  searchPaginated,
  stateCounts,
} from "$lib/server/manager";
import { DEFAULT_PAGE_SIZE } from "$lib/types";
import type { PageServerLoad } from "./$types";

/** Max accepted search query length — defends against pathological inputs. */
const MAX_QUERY_LEN = 100;

// Pick whichever logo asset is present, in order of preference.
function resolveLogoUrl(): string | null {
  for (const name of ["logo.svg", "logo.webp", "logo.png"]) {
    if (existsSync(join("static", "imgs", name))) return `/imgs/${name}`;
  }
  return null;
}

export const load: PageServerLoad = async ({ url }) => {
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const limit = Math.min(
    100,
    Math.max(
      1,
      parseInt(url.searchParams.get("limit") ?? String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE,
    ),
  );
  const batchPage = Math.max(1, parseInt(url.searchParams.get("bp") ?? "1", 10) || 1);

  // Free-text search: when present, return filtered/paginated results instead
  // of the normal three-section dashboard.
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
