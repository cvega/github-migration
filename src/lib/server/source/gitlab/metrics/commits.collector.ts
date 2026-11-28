import descriptor from "$lib/source/gitlab-metrics/commits.metric";
import type { ProfileNumericMetric, SourceProjectInventory } from "$lib/source/types";
import { type GitLabClient, GitLabRequestBudgetError } from "../client";
import { budgetObservation, metric, unavailableObservation } from "./counts";
import { defineGitLabCollector, type GitLabMetricOptions } from "./types";

export const GITLAB_COMMITS_SCOPE = "commits reachable from the default-branch head SHA";

export async function collectGitLabCommitMetric(
  client: GitLabClient,
  project: Pick<SourceProjectInventory, "sourceId" | "defaultBranch" | "providerDetails">,
  options: GitLabMetricOptions = {},
): Promise<ProfileNumericMetric> {
  const nowMs = options.nowMs ?? Date.now();
  if (project.providerDetails?.provider === "gitlab" && project.providerDetails.emptyRepository) {
    return metric(
      "repository-commit-sequence",
      { kind: "exact", value: 0, basis: "enumerated", scope: GITLAB_COMMITS_SCOPE },
      nowMs,
    );
  }
  if (!project.defaultBranch) {
    return metric(
      "repository-commit-sequence",
      { kind: "unavailable", reason: "not-reported", scope: GITLAB_COMMITS_SCOPE },
      nowMs,
    );
  }
  const projectId = encodeURIComponent(project.sourceId);
  let headSha: string | null = null;
  try {
    const branch = await client.get<unknown>(
      `/projects/${projectId}/repository/branches/${encodeURIComponent(project.defaultBranch)}`,
      {},
      { signal: options.signal, apiCallCeiling: options.apiCallCeiling },
    );
    const sha =
      typeof branch.data === "object" &&
      branch.data !== null &&
      "commit" in branch.data &&
      typeof branch.data.commit === "object" &&
      branch.data.commit !== null &&
      "id" in branch.data.commit &&
      typeof branch.data.commit.id === "string" &&
      // Blank or padded ids are not commit evidence.
      /^\S+$/.test(branch.data.commit.id)
        ? branch.data.commit.id
        : null;
    if (!sha) {
      return metric(
        "repository-commit-sequence",
        { kind: "unavailable", reason: "malformed", scope: GITLAB_COMMITS_SCOPE },
        nowMs,
      );
    }
    headSha = sha;
    const sequence = await client.get<unknown>(
      `/projects/${projectId}/repository/commits/${encodeURIComponent(sha)}/sequence`,
      {},
      { signal: options.signal, apiCallCeiling: options.apiCallCeiling },
    );
    const count =
      typeof sequence.data === "object" &&
      sequence.data !== null &&
      "count" in sequence.data &&
      typeof sequence.data.count === "number" &&
      Number.isSafeInteger(sequence.data.count) &&
      sequence.data.count >= 0
        ? sequence.data.count
        : null;
    return metric(
      "repository-commit-sequence",
      count === null
        ? { kind: "unavailable", reason: "malformed", scope: GITLAB_COMMITS_SCOPE }
        : { kind: "exact", value: count, basis: "reported", scope: GITLAB_COMMITS_SCOPE },
      nowMs,
    );
  } catch (error) {
    const observation =
      error instanceof GitLabRequestBudgetError
        ? // A valid default-branch head proves at least one commit even without its sequence.
          budgetObservation(GITLAB_COMMITS_SCOPE, headSha ? 1 : 0)
        : unavailableObservation(error, GITLAB_COMMITS_SCOPE);
    if (!observation) throw error;
    return metric("repository-commit-sequence", observation, nowMs);
  }
}

export default defineGitLabCollector(descriptor, collectGitLabCommitMetric);
