import { parseProfileNumericMetric } from "$lib/source/observations";
import { parseBitbucketProfileEnrichment } from "$lib/source/profile";
import type {
  BitbucketActivity,
  BitbucketProfileEnrichment,
  BitbucketProjectMetrics,
  ProfileNumericMetric,
  ProfileNumericObservation,
  SourceNamespaceInventory,
  SourceProjectInventory,
} from "$lib/source/types";
import { enrichmentWorkers } from "../enrichment-workers";
import {
  BitbucketServerApiError,
  type BitbucketServerClient,
  encodeBitbucketSegment,
} from "./client";

export const BITBUCKET_COMMITS_SCOPE = "commits reachable from the default branch";
export const BITBUCKET_PULL_REQUESTS_SCOPE =
  "incoming repository pull requests visible to the caller; all states";
export const BITBUCKET_BRANCHES_SCOPE = "all repository branches visible to the caller";
export const BITBUCKET_TAGS_SCOPE = "all repository tags visible to the caller";
export const BITBUCKET_FORKS_SCOPE = "all repository forks visible to the caller";

interface BitbucketProjectProfile {
  sourceId: string;
  path: string;
  metrics: BitbucketProjectMetrics;
  activity: BitbucketActivity;
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return null;
  const date = new Date(value);
  const year = date.getUTCFullYear();
  return year >= 0 && year <= 9999 ? date.toISOString() : null;
}

function repositoryPath(project: Pick<SourceProjectInventory, "path">): string {
  const [projectKey, repositorySlug, extra] = project.path.split("/");
  if (!projectKey || !repositorySlug || extra !== undefined) {
    throw new TypeError("Bitbucket repository path must be '<project-key>/<repository-slug>'");
  }
  return `/projects/${encodeBitbucketSegment(projectKey, "project key")}/repos/${encodeBitbucketSegment(repositorySlug, "repository slug")}`;
}

function unavailableObservation(error: unknown, scope: string): ProfileNumericObservation | null {
  if (!(error instanceof BitbucketServerApiError)) return null;
  if (error.status === 401 || error.status === 403) {
    return { kind: "unavailable", reason: "forbidden", scope };
  }
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
    provider: "bitbucket-server",
    endpointFamily,
    collectedAt: new Date(nowMs).toISOString(),
    observation,
  });
}

async function collectEnumeratedMetric(
  client: BitbucketServerClient,
  project: Pick<SourceProjectInventory, "path">,
  collection: string,
  endpointFamily: string,
  scope: string,
  query: Record<string, string | number | boolean>,
  options: { signal?: AbortSignal; nowMs?: number },
  observePage?: (values: unknown[]) => void,
): Promise<ProfileNumericMetric> {
  try {
    let value = 0;
    for await (const page of client.paginatePages<unknown>(
      `${repositoryPath(project)}/${collection}`,
      query,
      { signal: options.signal },
    )) {
      value += page.length;
      observePage?.(page);
    }
    return metric(
      endpointFamily,
      { kind: "exact", value, basis: "enumerated", scope },
      options.nowMs ?? Date.now(),
    );
  } catch (error) {
    const observation = unavailableObservation(error, scope);
    if (!observation) throw error;
    return metric(endpointFamily, observation, options.nowMs ?? Date.now());
  }
}

export async function collectBitbucketCommitMetric(
  client: BitbucketServerClient,
  project: Pick<SourceProjectInventory, "path" | "defaultBranch">,
  options: { signal?: AbortSignal; nowMs?: number } = {},
  observeTip?: (committedAt: string | null) => void,
): Promise<ProfileNumericMetric> {
  const nowMs = options.nowMs ?? Date.now();
  if (!project.defaultBranch) {
    return metric(
      "repository-commits",
      { kind: "unavailable", reason: "not-reported", scope: BITBUCKET_COMMITS_SCOPE },
      nowMs,
    );
  }
  try {
    const start = 0;
    const limit = 100;
    const response = await client.get<unknown>(
      `${repositoryPath(project)}/commits`,
      { until: project.defaultBranch, withCounts: true, start, limit },
      { signal: options.signal },
    );
    const malformed = () =>
      metric(
        "repository-commits",
        { kind: "unavailable", reason: "malformed", scope: BITBUCKET_COMMITS_SCOPE },
        nowMs,
      );
    if (
      !response ||
      typeof response !== "object" ||
      !("isLastPage" in response) ||
      typeof response.isLastPage !== "boolean" ||
      !("values" in response) ||
      !Array.isArray(response.values) ||
      !response.values.every(
        (commit) => commit && typeof commit === "object" && !Array.isArray(commit),
      )
    ) {
      return malformed();
    }

    const { isLastPage, values } = response;
    const reportedLimit = "limit" in response ? response.limit : limit;
    if (
      ("start" in response && response.start !== start) ||
      ("size" in response && response.size !== values.length) ||
      typeof reportedLimit !== "number" ||
      !Number.isSafeInteger(reportedLimit) ||
      reportedLimit < 1 ||
      reportedLimit > limit ||
      values.length > reportedLimit ||
      (isLastPage && "nextPageStart" in response)
    ) {
      return malformed();
    }

    observeTip?.(timestamp(values[0]?.committerTimestamp));

    const totalCount = "totalCount" in response ? response.totalCount : undefined;
    if (!isLastPage) {
      const nextPageStart = "nextPageStart" in response ? response.nextPageStart : undefined;
      if (
        typeof nextPageStart !== "number" ||
        !Number.isSafeInteger(nextPageStart) ||
        nextPageStart <= start ||
        (totalCount !== undefined &&
          (typeof totalCount !== "number" ||
            !Number.isSafeInteger(totalCount) ||
            totalCount <= values.length))
      ) {
        return malformed();
      }

      // Bitbucket may count only through the next item when more pages exist.
      return metric(
        "repository-commits",
        {
          kind: "at-least",
          value: values.length,
          reason: "page-cap",
          scope: BITBUCKET_COMMITS_SCOPE,
        },
        nowMs,
      );
    }

    // A terminal first page contains all commits in scope.
    if (totalCount !== values.length) return malformed();
    return metric(
      "repository-commits",
      { kind: "exact", value: totalCount, basis: "reported", scope: BITBUCKET_COMMITS_SCOPE },
      nowMs,
    );
  } catch (error) {
    const observation = unavailableObservation(error, BITBUCKET_COMMITS_SCOPE);
    if (!observation) throw error;
    return metric("repository-commits", observation, nowMs);
  }
}

async function collectBitbucketPullRequestMetric(
  client: BitbucketServerClient,
  project: Pick<SourceProjectInventory, "path">,
  options: { signal?: AbortSignal; nowMs?: number } = {},
) {
  const review: NonNullable<BitbucketActivity["review"]> = {
    open: 0,
    merged: 0,
    declined: 0,
    oldestOpenCreatedAt: null,
    latestUpdatedAt: null,
  };
  let unknownState = false,
    missingCreated = false,
    missingUpdated = false;
  const metric = await collectEnumeratedMetric(
    client,
    project,
    "pull-requests",
    "repository-pull-requests",
    BITBUCKET_PULL_REQUESTS_SCOPE,
    { direction: "INCOMING", state: "ALL" },
    options,
    (values) => {
      for (const pr of values) {
        if (!pr || typeof pr !== "object") {
          unknownState = true;
          continue;
        }
        const state = "state" in pr ? pr.state : null;
        if (state === "OPEN") {
          review.open++;
          const created = timestamp("createdDate" in pr ? pr.createdDate : null);
          if (!created) missingCreated = true;
          else if (!review.oldestOpenCreatedAt || created < review.oldestOpenCreatedAt)
            review.oldestOpenCreatedAt = created;
        } else if (state === "MERGED") review.merged++;
        else if (state === "DECLINED") review.declined++;
        else unknownState = true;
        const updated = timestamp("updatedDate" in pr ? pr.updatedDate : null);
        if (!updated) missingUpdated = true;
        else if (!review.latestUpdatedAt || updated > review.latestUpdatedAt)
          review.latestUpdatedAt = updated;
      }
    },
  );
  if (missingCreated) review.oldestOpenCreatedAt = null;
  if (missingUpdated) review.latestUpdatedAt = null;
  return { metric, review: metric.observation.kind === "exact" && !unknownState ? review : null };
}

export async function collectBitbucketBranchMetric(
  client: BitbucketServerClient,
  project: Pick<SourceProjectInventory, "path">,
  options: { signal?: AbortSignal; nowMs?: number } = {},
): Promise<ProfileNumericMetric> {
  return collectEnumeratedMetric(
    client,
    project,
    "branches",
    "repository-branches",
    BITBUCKET_BRANCHES_SCOPE,
    { details: false },
    options,
  );
}

async function collectBitbucketTagMetric(
  client: BitbucketServerClient,
  project: Pick<SourceProjectInventory, "path">,
  options: { signal?: AbortSignal; nowMs?: number } = {},
): Promise<ProfileNumericMetric> {
  return collectEnumeratedMetric(
    client,
    project,
    "tags",
    "repository-tags",
    BITBUCKET_TAGS_SCOPE,
    {},
    options,
  );
}

async function collectBitbucketForkMetric(
  client: BitbucketServerClient,
  project: Pick<SourceProjectInventory, "path">,
  options: { signal?: AbortSignal; nowMs?: number } = {},
): Promise<ProfileNumericMetric> {
  return collectEnumeratedMetric(
    client,
    project,
    "forks",
    "repository-forks",
    BITBUCKET_FORKS_SCOPE,
    {},
    options,
  );
}

export async function collectBitbucketProfileEnrichment(
  client: BitbucketServerClient,
  inventory: SourceNamespaceInventory,
  options: { signal?: AbortSignal; nowMs?: number; concurrency?: number } = {},
): Promise<BitbucketProfileEnrichment> {
  if (inventory.provider !== "bitbucket-server") {
    throw new TypeError("Bitbucket enrichment requires a Bitbucket Server inventory");
  }
  const concurrency = options.concurrency ?? 2;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new TypeError("Bitbucket profile concurrency must be an integer between 1 and 8");
  }

  const workers = enrichmentWorkers(options.signal);
  const metricOptions = { ...options, signal: workers.signal };
  const projects = new Array<BitbucketProjectProfile>(inventory.projects.length);
  let nextProject = 0;
  const worker = async (): Promise<void> => {
    while (nextProject < inventory.projects.length) {
      workers.signal.throwIfAborted();
      const position = nextProject++;
      const project = inventory.projects[position];
      if (!project) return;
      const activity: BitbucketActivity = {
        defaultBranch: project.defaultBranch,
        tipCommittedAt: null,
        review: null,
      };
      const commits = await collectBitbucketCommitMetric(client, project, metricOptions, (date) => {
        activity.tipCommittedAt = date;
      });
      const { metric: pullRequests, review } = await collectBitbucketPullRequestMetric(
        client,
        project,
        metricOptions,
      );
      activity.review = review;
      const branches = await collectBitbucketBranchMetric(client, project, metricOptions);
      const tags = await collectBitbucketTagMetric(client, project, metricOptions);
      const forks = await collectBitbucketForkMetric(client, project, metricOptions);
      projects[position] = {
        sourceId: project.sourceId,
        path: project.path,
        activity,
        metrics: { commits, pullRequests, branches, tags, forks },
      };
    }
  };
  await workers.join(
    Array.from({ length: Math.min(concurrency, inventory.projects.length) }, () => worker()),
  );

  return parseBitbucketProfileEnrichment({
    version: 2,
    provider: "bitbucket-server",
    sourceApiUrl: inventory.sourceApiUrl,
    namespace: inventory.namespace,
    projects,
  });
}
