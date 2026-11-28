import { GITLAB_PROFILE_METRIC_KEYS, type GitLabMetricKey } from "$lib/source/gitlab-metrics";
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
  GitLabRequestBudgetError,
} from "./client";
import { DEFAULT_GITLAB_PROFILE_REQUEST_BUDGET } from "./config";
import { GITLAB_PROFILE_CONCURRENCY } from "./inventory";

export const GITLAB_ISSUES_SCOPE =
  "project issues visible to the caller; all states and authors; excludes merge requests";
export const GITLAB_MERGE_REQUESTS_SCOPE =
  "project merge requests visible to the caller; all states and authors";
export const GITLAB_BRANCHES_SCOPE = "all repository branches visible to the caller";
export const GITLAB_TAGS_SCOPE = "all repository tags visible to the caller";
export const GITLAB_RELEASES_SCOPE = "all GitLab releases visible to the caller";
export const GITLAB_COMMITS_SCOPE = "commits reachable from the default-branch head SHA";

/**
 * Shared by every collector in one profile run. `apiCallCeiling` is an absolute
 * limit on the client's call counter, so retries and pagination of concurrent
 * collectors all spend the same budget.
 */
interface GitLabMetricOptions {
  signal?: AbortSignal;
  nowMs?: number;
  apiCallCeiling?: number;
}

type GitLabMetricProject = Pick<
  SourceProjectInventory,
  "sourceId" | "defaultBranch" | "providerDetails"
>;

type GitLabMetricCollector = (
  client: GitLabClient,
  project: GitLabMetricProject,
  options?: GitLabMetricOptions,
) => Promise<ProfileNumericMetric>;

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

/** Counts already read are a lower bound; with nothing read the metric is unavailable. */
function budgetObservation(scope: string, itemsRead = 0): ProfileNumericObservation {
  return itemsRead > 0
    ? { kind: "at-least", value: itemsRead, reason: "request-budget", scope }
    : { kind: "unavailable", reason: "request-budget", scope };
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
  options: GitLabMetricOptions,
): Promise<ProfileNumericMetric> {
  const nowMs = options.nowMs ?? Date.now();
  try {
    const count = await client.count(
      `/projects/${encodeURIComponent(projectId)}/${collection}`,
      query,
      { signal: options.signal, apiCallCeiling: options.apiCallCeiling },
    );
    return metric(endpointFamily, scopedCountObservation(count, scope), nowMs);
  } catch (error) {
    if (!(error instanceof GitLabRequestBudgetError)) throw error;
    return metric(endpointFamily, budgetObservation(scope), nowMs);
  }
}

async function collectEnumeratedCountMetric(
  client: GitLabClient,
  projectId: string,
  collection: string,
  endpointFamily: string,
  scope: string,
  options: GitLabMetricOptions,
): Promise<ProfileNumericMetric> {
  let value = 0;
  try {
    for await (const page of client.paginatePages<unknown>(
      `/projects/${encodeURIComponent(projectId)}/${collection}`,
      {},
      { signal: options.signal, apiCallCeiling: options.apiCallCeiling },
    )) {
      value += page.length;
    }
    return metric(
      endpointFamily,
      { kind: "exact", value, basis: "enumerated", scope },
      options.nowMs ?? Date.now(),
    );
  } catch (error) {
    if (error instanceof GitLabRequestBudgetError) {
      return metric(endpointFamily, budgetObservation(scope, value), options.nowMs ?? Date.now());
    }
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

/** Every registry key must have exactly one collector; the compiler enforces it. */
const GITLAB_METRIC_COLLECTORS = {
  issues: collectGitLabIssueMetric,
  mergeRequests: collectGitLabMergeRequestMetric,
  commits: collectGitLabCommitMetric,
  branches: collectGitLabBranchMetric,
  tags: collectGitLabTagMetric,
  releases: collectGitLabReleaseMetric,
} satisfies Record<GitLabMetricKey, GitLabMetricCollector>;

export async function collectGitLabProfileEnrichment(
  client: GitLabClient,
  inventory: SourceNamespaceInventory,
  options: {
    signal?: AbortSignal;
    nowMs?: number;
    concurrency?: number;
    /** Requests this collection may issue, retries and pagination included. */
    requestBudget?: number;
    /**
     * Absolute limit on the client's call counter shared with earlier phases of
     * the same profile run. Takes precedence over `requestBudget`.
     */
    apiCallCeiling?: number;
  } = {},
): Promise<GitLabProfileEnrichment> {
  if (inventory.provider !== "gitlab") {
    throw new TypeError("GitLab enrichment requires a GitLab inventory");
  }
  const concurrency = options.concurrency ?? GITLAB_PROFILE_CONCURRENCY;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new TypeError("GitLab profile concurrency must be an integer between 1 and 16");
  }
  const requestBudget = options.requestBudget ?? DEFAULT_GITLAB_PROFILE_REQUEST_BUDGET;
  if (!Number.isSafeInteger(requestBudget) || requestBudget < 0) {
    throw new RangeError("GitLab profile request budget must be a non-negative integer");
  }
  if (
    options.apiCallCeiling !== undefined &&
    (!Number.isSafeInteger(options.apiCallCeiling) || options.apiCallCeiling < 0)
  ) {
    throw new RangeError("GitLab API call ceiling must be a non-negative integer");
  }

  const workers = enrichmentWorkers(options.signal);
  const metricOptions: GitLabMetricOptions = {
    signal: workers.signal,
    nowMs: options.nowMs,
    // The client counts every attempt synchronously before sending it, so this
    // one ceiling cannot be overshot by concurrent workers or retries.
    apiCallCeiling: options.apiCallCeiling ?? client.getApiCalls() + requestBudget,
  };
  const projects = new Array<GitLabProjectProfile>(inventory.projects.length);
  let nextProject = 0;
  const worker = async (): Promise<void> => {
    while (nextProject < inventory.projects.length) {
      workers.signal.throwIfAborted();
      const position = nextProject++;
      const project = inventory.projects[position];
      if (!project) return;
      const collected = await workers.join(
        GITLAB_PROFILE_METRIC_KEYS.map((key) =>
          GITLAB_METRIC_COLLECTORS[key](client, project, metricOptions),
        ),
      );
      projects[position] = {
        sourceId: project.sourceId,
        path: project.path,
        metrics: Object.fromEntries(
          GITLAB_PROFILE_METRIC_KEYS.map((key, index) => [key, collected[index]]),
        ) as GitLabProjectMetrics,
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
