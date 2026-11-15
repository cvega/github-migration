import { env } from "node:process";
import { getFormDefaults, isSourceAuthAvailable } from "$lib/server/core/auth";
import {
  countProfileRuns,
  listProfileRunsWithInventoryCounts,
} from "$lib/server/profile/database/runs";
import { getBitbucketServerSourceConfig } from "$lib/server/source/bitbucket/config";
import { getGitLabSourceConfig } from "$lib/server/source/gitlab/config";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = () => {
  const gitlab = getGitLabSourceConfig();
  const bitbucket = getBitbucketServerSourceConfig();
  return {
    runs: listProfileRunsWithInventoryCounts(),
    totalRuns: countProfileRuns(),
    sourceOrgs: getFormDefaults().sourceOrgs,
    providerAuthAvailable: {
      github: isSourceAuthAvailable(),
      gitlab: gitlab.authAvailable,
      "bitbucket-server": bitbucket.authAvailable,
    },
    bitbucketProjectKeys: (env.BITBUCKET_SERVER_PROJECT_KEYS ?? "")
      .split(/[\s,]+/)
      .map((value) => value.trim())
      .filter(Boolean),
  };
};
