import { error } from "@sveltejs/kit";
import { parsePaginationParams } from "$lib/migrate/types";
import { visibleBatch } from "$lib/server/application/self-service/visible-jobs";
import { batchHasSavedTlsOverride } from "$lib/server/migrate/database/batches";
import {
  getBatchPaginated,
  getBatchSourceProviders,
  getRestartableBatchCount,
} from "$lib/server/migrate/manager";
import { isSourceProvider } from "$lib/source-provider";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ params, url, locals }) => {
  const paging = parsePaginationParams(url.searchParams);
  if (locals?.user?.role === "operator") {
    const result = visibleBatch(locals.user.id, params.id, paging);
    if (!result) error(404, "Batch not found");
    return {
      scoped: true,
      batch: result.summary,
      migrations: result.migrations,
      restartableCount: 0,
      sourceProvider: null,
    };
  }
  const result = getBatchPaginated(params.id, paging);
  if (!result) throw error(404, "Batch not found");
  const providers = getBatchSourceProviders(params.id);
  return {
    scoped: false,
    savedInsecureSourceTls: batchHasSavedTlsOverride(params.id),
    batch: result.summary,
    migrations: result.migrations,
    restartableCount: providers.every(isSourceProvider) ? getRestartableBatchCount(params.id) : 0,
    sourceProvider: providers.length === 1 && isSourceProvider(providers[0]) ? providers[0] : null,
  };
};
