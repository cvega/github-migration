import descriptor from "$lib/source/gitlab-metrics/releases.metric";
import type { ProfileNumericMetric, SourceProjectInventory } from "$lib/source/types";
import type { GitLabClient } from "../client";
import { collectEnumeratedCountMetric } from "./counts";
import { defineGitLabCollector, type GitLabMetricOptions } from "./types";

export const GITLAB_RELEASES_SCOPE = "all GitLab releases visible to the caller";

export async function collectGitLabReleaseMetric(
  client: GitLabClient,
  project: Pick<SourceProjectInventory, "sourceId">,
  options: GitLabMetricOptions = {},
): Promise<ProfileNumericMetric> {
  return collectEnumeratedCountMetric(
    client,
    project.sourceId,
    "releases",
    "project-releases",
    GITLAB_RELEASES_SCOPE,
    options,
  );
}

export default defineGitLabCollector(descriptor, collectGitLabReleaseMetric);
