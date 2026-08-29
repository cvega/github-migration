import { parseProfileNumericMetric } from "$lib/source/observations";
import { parseBitbucketProfileEnrichment } from "$lib/source/profile";
import type {
  BitbucketProfileEnrichment,
  BitbucketProjectMetrics,
  ProfileNumericMetric,
  ProfileNumericObservation,
  SourceNamespaceInventory,
  SourceProjectInventory,
} from "$lib/source/types";
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
): Promise<ProfileNumericMetric> {
  try {
    let value = 0;
    for await (const page of client.paginatePages<unknown>(
      `${repositoryPath(project)}/${collection}`,
      query,
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
    return metric(endpointFamily, observation, options.nowMs ?? Date.now());
  }
}

export async function collectBitbucketCommitMetric(
  client: BitbucketServerClient,
  project: Pick<SourceProjectInventory, "path" | "defaultBranch">,
  options: { signal?: AbortSignal; nowMs?: number } = {},
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
    const response = await client.get<unknown>(
      `${repositoryPath(project)}/commits`,
      { until: project.defaultBranch, withCounts: true, limit: 1 },
      { signal: options.signal },
    );
    const totalCount =
      typeof response === "object" &&
      response !== null &&
      "totalCount" in response &&
      typeof response.totalCount === "number" &&
      Number.isSafeInteger(response.totalCount) &&
      response.totalCount >= 0
        ? response.totalCount
        : null;
    return metric(
      "repository-commits",
      totalCount === null
        ? { kind: "unavailable", reason: "malformed", scope: BITBUCKET_COMMITS_SCOPE }
        : {
            kind: "exact",
            value: totalCount,
            basis: "reported",
            scope: BITBUCKET_COMMITS_SCOPE,
          },
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
): Promise<ProfileNumericMetric> {
  return collectEnumeratedMetric(
    client,
    project,
    "pull-requests",
    "repository-pull-requests",
    BITBUCKET_PULL_REQUESTS_SCOPE,
    { direction: "INCOMING", state: "ALL" },
    options,
  );
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

  const projects = new Array<BitbucketProjectProfile>(inventory.projects.length);
  let nextProject = 0;
  const worker = async (): Promise<void> => {
    while (nextProject < inventory.projects.length) {
      const position = nextProject++;
      const project = inventory.projects[position];
      if (!project) return;
      const commits = await collectBitbucketCommitMetric(client, project, options);
      const pullRequests = await collectBitbucketPullRequestMetric(client, project, options);
      const branches = await collectBitbucketBranchMetric(client, project, options);
      const tags = await collectBitbucketTagMetric(client, project, options);
      const forks = await collectBitbucketForkMetric(client, project, options);
      projects[position] = {
        sourceId: project.sourceId,
        path: project.path,
        metrics: { commits, pullRequests, branches, tags, forks },
      };
    }
  };
  await Promise.all(
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
