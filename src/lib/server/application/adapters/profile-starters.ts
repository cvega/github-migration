import {
  runBitbucketInventoryProfile,
  runGitLabInventoryProfile,
} from "$lib/server/profile/inventory-runner";
import {
  startBitbucketServerProfile,
  startGitLabProfile,
  startOrgProfile,
} from "$lib/server/profile/service";
import { BitbucketServerApiError } from "$lib/server/source/bitbucket/client";
import { getBitbucketServerSourceClient } from "$lib/server/source/bitbucket/config";
import { discoverBitbucketInventory } from "$lib/server/source/bitbucket/inventory";
import { collectBitbucketProfileEnrichment } from "$lib/server/source/bitbucket/profile";
import { GitLabApiError, type GitLabClient } from "$lib/server/source/gitlab/client";
import {
  getGitLabProfileRequestBudget,
  getGitLabSourceClient,
} from "$lib/server/source/gitlab/config";
import {
  type DiscoverGitLabInventoryOptions,
  discoverGitLabInventory,
} from "$lib/server/source/gitlab/inventory";
import { collectGitLabProfileEnrichment } from "$lib/server/source/gitlab/profile";
import type { SourceNamespaceInventory } from "$lib/source/types";

/**
 * Discovery and metric collection for one GitLab profile run. Optional
 * statistics requests stop at the discovery cutoff (`optionalStatisticsRequests`,
 * counted from the start of the run) or at the shared request budget, whichever
 * is reached first; metric requests stop only at the shared budget. Both are
 * ceilings on the client's call counter, so retries count and concurrent
 * workers cannot overshoot. Required listing pages are never refused.
 */
export function gitLabProfileRunnerDeps(
  client: GitLabClient,
  requestBudget: number,
  options: { optionalStatisticsRequests?: number } = {},
) {
  const apiCallCeiling = client.getApiCalls() + requestBudget;
  return {
    discover: (
      sourceClient: GitLabClient,
      requested: string,
      discovery: DiscoverGitLabInventoryOptions,
    ) =>
      discoverGitLabInventory(sourceClient, requested, {
        ...discovery,
        apiCallCeiling,
        requestBudget: options.optionalStatisticsRequests,
      }),
    enrich: (
      sourceClient: GitLabClient,
      inventory: SourceNamespaceInventory,
      enrichment: { signal?: AbortSignal },
    ) => collectGitLabProfileEnrichment(sourceClient, inventory, { ...enrichment, apiCallCeiling }),
    isApiError: (error: unknown) => error instanceof GitLabApiError,
  };
}

export const profileStarters = {
  github: startOrgProfile,
  gitlab: (namespace: string) => {
    // Resolve before creating a run so an invalid setting fails the request.
    const requestBudget = getGitLabProfileRequestBudget();
    return startGitLabProfile(namespace, {
      buildSourceClient: getGitLabSourceClient,
      run: (client, input, onProgress) =>
        runGitLabInventoryProfile(
          client,
          input,
          onProgress,
          gitLabProfileRunnerDeps(client, requestBudget),
        ),
      newId: () => Bun.randomUUIDv7(),
    });
  },
  "bitbucket-server": (namespace: string) =>
    startBitbucketServerProfile(namespace, {
      buildSourceClient: getBitbucketServerSourceClient,
      run: (client, input, onProgress) =>
        runBitbucketInventoryProfile(client, input, onProgress, {
          discover: (client, namespace, options) =>
            discoverBitbucketInventory(client, namespace, {
              ...options,
              includeStorage: true,
              checkLfs: true,
            }),
          enrich: collectBitbucketProfileEnrichment,
          isApiError: (error) => error instanceof BitbucketServerApiError,
        }),
      newId: () => Bun.randomUUIDv7(),
    }),
};
