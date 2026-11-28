import descriptor from "$lib/source/gitlab-metrics/issues.metric";
import type { ProfileNumericMetric, SourceProjectInventory } from "$lib/source/types";
import type { GitLabClient } from "../client";
import { collectFirstPageCountMetric } from "./counts";
import { defineGitLabCollector, type GitLabMetricOptions } from "./types";

export const GITLAB_ISSUES_SCOPE =
  "project issues visible to the caller; all states and authors; excludes merge requests";

export async function collectGitLabIssueMetric(
  client: GitLabClient,
  project: Pick<SourceProjectInventory, "sourceId">,
  options: GitLabMetricOptions = {},
): Promise<ProfileNumericMetric> {
  return collectFirstPageCountMetric(
    client,
    project.sourceId,
    "issues",
    "project-issues",
    GITLAB_ISSUES_SCOPE,
    { scope: "all", state: "all" },
    options,
  );
}

export default defineGitLabCollector(descriptor, collectGitLabIssueMetric);
