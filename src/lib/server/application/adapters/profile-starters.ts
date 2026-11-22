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
import { getGitLabSourceClient } from "$lib/server/source/gitlab/config";
import { discoverGitLabInventory } from "$lib/server/source/gitlab/inventory";
import { collectGitLabProfileEnrichment } from "$lib/server/source/gitlab/profile";

export const profileStarters = {
  github: startOrgProfile,
  gitlab: (namespace: string) =>
    startGitLabProfile(namespace, {
      buildSourceClient: getGitLabSourceClient,
      run: (client, input, onProgress) =>
        runGitLabInventoryProfile(client, input, onProgress, {
          discover: discoverGitLabInventory,
          enrich: collectGitLabProfileEnrichment,
          isApiError: (error) => error instanceof GitLabApiError,
        }),
      newId: () => Bun.randomUUIDv7(),
    }),
  "bitbucket-server": (namespace: string) =>
    startBitbucketServerProfile(namespace, {
      buildSourceClient: getBitbucketServerSourceClient,
      run: (client, input, onProgress) =>
        runBitbucketInventoryProfile(client, input, onProgress, {
          discover: discoverBitbucketInventory,
          enrich: collectBitbucketProfileEnrichment,
          isApiError: (error) => error instanceof BitbucketServerApiError,
        }),
      newId: () => Bun.randomUUIDv7(),
    }),
};
