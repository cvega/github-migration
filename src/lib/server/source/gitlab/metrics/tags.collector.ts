import descriptor from "$lib/source/gitlab-metrics/tags.metric";
import type { ProfileNumericMetric, SourceProjectInventory } from "$lib/source/types";
import type { GitLabClient } from "../client";
import { collectEnumeratedCountMetric } from "./counts";
import { defineGitLabCollector, type GitLabMetricOptions } from "./types";

export const GITLAB_TAGS_SCOPE = "all repository tags visible to the caller";

export async function collectGitLabTagMetric(
  client: GitLabClient,
  project: Pick<SourceProjectInventory, "sourceId">,
  options: GitLabMetricOptions = {},
): Promise<ProfileNumericMetric> {
  return collectEnumeratedCountMetric(
    client,
    project.sourceId,
    "repository/tags",
    "repository-tags",
    GITLAB_TAGS_SCOPE,
    options,
  );
}

export default defineGitLabCollector(descriptor, collectGitLabTagMetric);
