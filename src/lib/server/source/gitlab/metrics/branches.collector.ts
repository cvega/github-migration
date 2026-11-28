import descriptor from "$lib/source/gitlab-metrics/branches.metric";
import type { ProfileNumericMetric, SourceProjectInventory } from "$lib/source/types";
import type { GitLabClient } from "../client";
import { collectEnumeratedCountMetric } from "./counts";
import { defineGitLabCollector, type GitLabMetricOptions } from "./types";

export const GITLAB_BRANCHES_SCOPE = "all repository branches visible to the caller";

export async function collectGitLabBranchMetric(
  client: GitLabClient,
  project: Pick<SourceProjectInventory, "sourceId">,
  options: GitLabMetricOptions = {},
): Promise<ProfileNumericMetric> {
  return collectEnumeratedCountMetric(
    client,
    project.sourceId,
    "repository/branches",
    "repository-branches",
    GITLAB_BRANCHES_SCOPE,
    options,
  );
}

export default defineGitLabCollector(descriptor, collectGitLabBranchMetric);
