import { error } from "@sveltejs/kit";
import { parsePaginationParams } from "$lib/migrate/types";
import {
  getBatchPaginated,
  getBatchSourceProviders,
  getRestartableBatchCount,
} from "$lib/server/migrate/manager";
import { isSourceProvider } from "$lib/source-provider";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ params, url }) => {
  const result = getBatchPaginated(params.id, parsePaginationParams(url.searchParams));
  if (!result) throw error(404, "Batch not found");
  const providers = getBatchSourceProviders(params.id);
  return {
    batch: result.summary,
    migrations: result.migrations,
    restartableCount: providers.every(isSourceProvider) ? getRestartableBatchCount(params.id) : 0,
    sourceProvider: providers.length === 1 && isSourceProvider(providers[0]) ? providers[0] : null,
  };
};
