import { error } from "@sveltejs/kit";
import { parsePaginationParams } from "$lib/migrate/types";
import { getBatchPaginated, getBatchSourceProviders } from "$lib/server/migrate/manager";
import {
  getMigrationExecutor,
  getSourceProviderAdapter,
  isSourceProvider,
} from "$lib/source-provider";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ params, url }) => {
  const result = getBatchPaginated(params.id, parsePaginationParams(url.searchParams));
  if (!result) throw error(404, "Batch not found");
  const providers = getBatchSourceProviders(params.id);
  return {
    batch: result.summary,
    migrations: result.migrations,
    canRestart: providers.every(
      (provider) =>
        isSourceProvider(provider) &&
        getSourceProviderAdapter(provider).capabilities.restart &&
        getMigrationExecutor(provider) !== null,
    ),
    sourceProvider: providers.length === 1 && isSourceProvider(providers[0]) ? providers[0] : null,
  };
};
