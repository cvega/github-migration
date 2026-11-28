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
import { GitLabApiError } from "$lib/server/source/gitlab/client";
import {
  getGitLabProfileRequestBudget,
  getGitLabSourceClient,
} from "$lib/server/source/gitlab/config";
import { discoverGitLabInventory } from "$lib/server/source/gitlab/inventory";
import { collectGitLabProfileEnrichment } from "$lib/server/source/gitlab/profile";

export const profileStarters = {
  github: startOrgProfile,
  gitlab: (namespace: string) => {
    // Resolve before creating a run so an invalid setting fails the request.
    const requestBudget = getGitLabProfileRequestBudget();
    return startGitLabProfile(namespace, {
      buildSourceClient: getGitLabSourceClient,
      run: (client, input, onProgress) => {
        // One allowance for the whole run: optional inventory statistics requests
        // and metric collection spend the same ceiling on the client's call
        // counter, retries included. Required listing pages are never refused.
        const apiCallCeiling = client.getApiCalls() + requestBudget;
        return runGitLabInventoryProfile(client, input, onProgress, {
          discover: (sourceClient, requested, options) =>
            discoverGitLabInventory(sourceClient, requested, { ...options, apiCallCeiling }),
          enrich: (sourceClient, inventory, options) =>
            collectGitLabProfileEnrichment(sourceClient, inventory, { ...options, apiCallCeiling }),
          isApiError: (error) => error instanceof GitLabApiError,
        });
      },
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
