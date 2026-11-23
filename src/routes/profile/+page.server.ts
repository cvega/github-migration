import { env } from "node:process";
import { getFormDefaults, isSourceAuthAvailable } from "$lib/server/core/auth";
import {
  countProfileRuns,
  listProfileRunsWithInventoryCounts,
} from "$lib/server/profile/database/runs";
import { getBitbucketServerSourceConfig } from "$lib/server/source/bitbucket/config";
import { getGitLabSourceConfig } from "$lib/server/source/gitlab/config";
import type { PageServerLoad } from "./$types";

const RUNS_PER_PAGE = 10;

export const load: PageServerLoad = ({ url }) => {
  const gitlab = getGitLabSourceConfig();
  const bitbucket = getBitbucketServerSourceConfig();
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
  const total = countProfileRuns(q);
  const totalPages = Math.max(1, Math.ceil(total / RUNS_PER_PAGE));
  const requested = Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1;
  const page = Math.min(totalPages, Math.max(1, requested));
  return {
    runs: listProfileRunsWithInventoryCounts(RUNS_PER_PAGE, (page - 1) * RUNS_PER_PAGE, q),
    pagination: { page, totalPages, total, limit: RUNS_PER_PAGE },
    q,
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
