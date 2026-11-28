import descriptor from "$lib/source/gitlab-metrics/merge-requests.metric";
import type { ProfileNumericMetric, SourceProjectInventory } from "$lib/source/types";
import type { GitLabClient } from "../client";
import { collectFirstPageCountMetric } from "./counts";
import { defineGitLabCollector, type GitLabMetricOptions } from "./types";

export const GITLAB_MERGE_REQUESTS_SCOPE =
  "project merge requests visible to the caller; all states and authors";

export async function collectGitLabMergeRequestMetric(
  client: GitLabClient,
  project: Pick<SourceProjectInventory, "sourceId">,
  options: GitLabMetricOptions = {},
): Promise<ProfileNumericMetric> {
  return collectFirstPageCountMetric(
    client,
    project.sourceId,
    "merge_requests",
    "project-merge-requests",
    GITLAB_MERGE_REQUESTS_SCOPE,
    { scope: "all", state: "all" },
    options,
  );
}

export default defineGitLabCollector(descriptor, collectGitLabMergeRequestMetric);
