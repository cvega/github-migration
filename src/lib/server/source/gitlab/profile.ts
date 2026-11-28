import { parseProfileNumericMetric } from "$lib/source/observations";
import { parseGitLabProfileEnrichment } from "$lib/source/profile";
import type {
  GitLabProfileEnrichment,
  GitLabProjectMetrics,
  ProfileNumericMetric,
  ProfileNumericObservation,
  SourceNamespaceInventory,
  SourceProjectInventory,
} from "$lib/source/types";
import { enrichmentWorkers } from "../enrichment-workers";
import {
  GitLabApiError,
  type GitLabClient,
  type GitLabCountObservation,
  GitLabPaginationError,
} from "./client";

import { GITLAB_PROFILE_CONCURRENCY } from "./inventory";

export const GITLAB_ISSUES_SCOPE =
  "project issues visible to the caller; all states and authors; excludes merge requests";
export const GITLAB_MERGE_REQUESTS_SCOPE =
  "project merge requests visible to the caller; all states and authors";
export const GITLAB_BRANCHES_SCOPE = "all repository branches visible to the caller";
export const GITLAB_TAGS_SCOPE = "all repository tags visible to the caller";
export const GITLAB_RELEASES_SCOPE = "all GitLab releases visible to the caller";
export const GITLAB_COMMITS_SCOPE = "commits reachable from the default-branch head SHA";

interface GitLabProjectProfile {
  sourceId: string;
  path: string;
  metrics: GitLabProjectMetrics;
}

function scopedCountObservation(
  count: GitLabCountObservation,
  scope: string,
): ProfileNumericObservation {
  if (count.kind === "at-least") {
    return { ...count, reason: "request-budget", scope };
  }
  return { ...count, scope };
}

function unavailableObservation(error: unknown, scope: string): ProfileNumericObservation | null {
  if (!(error instanceof GitLabApiError)) return null;
  if (error instanceof GitLabPaginationError) {
    return { kind: "unavailable", reason: "malformed", scope };
  }
  if (error.status === 403) return { kind: "unavailable", reason: "forbidden", scope };
  if (error.status === 404) {
    return { kind: "unavailable", reason: "not-found-or-hidden", scope };
  }
  return null;
}

function metric(
  endpointFamily: string,
  observation: ProfileNumericObservation,
  nowMs: number,
): ProfileNumericMetric {
  return parseProfileNumericMetric({
    provider: "gitlab",
    endpointFamily,
    collectedAt: new Date(nowMs).toISOString(),
    observation,
  });
}

async function collectFirstPageCountMetric(
  client: GitLabClient,
  projectId: string,
  collection: string,
  endpointFamily: string,
  scope: string,
  query: Record<string, string>,
  options: { signal?: AbortSignal; nowMs?: number },
): Promise<ProfileNumericMetric> {
  const count = await client.count(
    `/projects/${encodeURIComponent(projectId)}/${collection}`,
    query,
    { signal: options.signal },
  );
  return metric(endpointFamily, scopedCountObservation(count, scope), options.nowMs ?? Date.now());
}

async function collectEnumeratedCountMetric(
  client: GitLabClient,
  projectId: string,
  collection: string,
  endpointFamily: string,
  scope: string,
  options: { signal?: AbortSignal; nowMs?: number },
): Promise<ProfileNumericMetric> {
  try {
    let value = 0;
    for await (const page of client.paginatePages<unknown>(
      `/projects/${encodeURIComponent(projectId)}/${collection}`,
      {},
      { signal: options.signal },
    )) {
      value += page.length;
    }
    return metric(
      endpointFamily,
      { kind: "exact", value, basis: "enumerated", scope },
      options.nowMs ?? Date.now(),
    );
  } catch (error) {
    const observation = unavailableObservation(error, scope);
    if (!observation) throw error;
    if (error instanceof GitLabPaginationError) {
      console.warn(`[gitlab] ${endpointFamily} count unavailable: ${error.message}`);
    }
    return metric(endpointFamily, observation, options.nowMs ?? Date.now());
  }
}

export async function collectGitLabIssueMetric(
  client: GitLabClient,
  project: Pick<SourceProjectInventory, "sourceId">,
  options: { signal?: AbortSignal; nowMs?: number } = {},
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

export async function collectGitLabMergeRequestMetric(
  client: GitLabClient,
  project: Pick<SourceProjectInventory, "sourceId">,
  options: { signal?: AbortSignal; nowMs?: number } = {},
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

export async function collectGitLabBranchMetric(
  client: GitLabClient,
  project: Pick<SourceProjectInventory, "sourceId">,
  options: { signal?: AbortSignal; nowMs?: number } = {},
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

export async function collectGitLabTagMetric(
  client: GitLabClient,
  project: Pick<SourceProjectInventory, "sourceId">,
  options: { signal?: AbortSignal; nowMs?: number } = {},
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

export async function collectGitLabReleaseMetric(
  client: GitLabClient,
  project: Pick<SourceProjectInventory, "sourceId">,
  options: { signal?: AbortSignal; nowMs?: number } = {},
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

export async function collectGitLabCommitMetric(
  client: GitLabClient,
  project: Pick<SourceProjectInventory, "sourceId" | "defaultBranch" | "providerDetails">,
  options: { signal?: AbortSignal; nowMs?: number } = {},
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
  try {
    const branch = await client.get<unknown>(
      `/projects/${projectId}/repository/branches/${encodeURIComponent(project.defaultBranch)}`,
      {},
      { signal: options.signal },
    );
    const sha =
      typeof branch.data === "object" &&
      branch.data !== null &&
      "commit" in branch.data &&
      typeof branch.data.commit === "object" &&
      branch.data.commit !== null &&
      "id" in branch.data.commit &&
      typeof branch.data.commit.id === "string"
        ? branch.data.commit.id
        : null;
    if (!sha) {
      return metric(
        "repository-commit-sequence",
        { kind: "unavailable", reason: "malformed", scope: GITLAB_COMMITS_SCOPE },
        nowMs,
      );
    }
    const sequence = await client.get<unknown>(
      `/projects/${projectId}/repository/commits/${encodeURIComponent(sha)}/sequence`,
      {},
      { signal: options.signal },
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
    const observation = unavailableObservation(error, GITLAB_COMMITS_SCOPE);
    if (!observation) throw error;
    return metric("repository-commit-sequence", observation, nowMs);
  }
}

export async function collectGitLabProfileEnrichment(
  client: GitLabClient,
  inventory: SourceNamespaceInventory,
  options: { signal?: AbortSignal; nowMs?: number; concurrency?: number } = {},
): Promise<GitLabProfileEnrichment> {
  if (inventory.provider !== "gitlab") {
    throw new TypeError("GitLab enrichment requires a GitLab inventory");
  }
  const concurrency = options.concurrency ?? GITLAB_PROFILE_CONCURRENCY;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new TypeError("GitLab profile concurrency must be an integer between 1 and 16");
  }

  const workers = enrichmentWorkers(options.signal);
  const metricOptions = { ...options, signal: workers.signal };
  const projects = new Array<GitLabProjectProfile>(inventory.projects.length);
  let nextProject = 0;
  const worker = async (): Promise<void> => {
    while (nextProject < inventory.projects.length) {
      workers.signal.throwIfAborted();
      const position = nextProject++;
      const project = inventory.projects[position];
      if (!project) return;
      const [issues, mergeRequests, commits, branches, tags, releases] = await workers.join([
        collectGitLabIssueMetric(client, project, metricOptions),
        collectGitLabMergeRequestMetric(client, project, metricOptions),
        collectGitLabCommitMetric(client, project, metricOptions),
        collectGitLabBranchMetric(client, project, metricOptions),
        collectGitLabTagMetric(client, project, metricOptions),
        collectGitLabReleaseMetric(client, project, metricOptions),
      ]);
      projects[position] = {
        sourceId: project.sourceId,
        path: project.path,
        metrics: { issues, mergeRequests, commits, branches, tags, releases },
      };
    }
  };
  await workers.join(
    Array.from({ length: Math.min(concurrency, inventory.projects.length) }, () => worker()),
  );

  return parseGitLabProfileEnrichment({
    version: 2,
    provider: "gitlab",
    sourceApiUrl: inventory.sourceApiUrl,
    namespace: inventory.namespace,
    projects,
  });
}
