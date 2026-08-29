import type {
  NumericObservation,
  SourceInventoryProgress,
  SourceNamespaceInventory,
  SourceProjectInventory,
} from "$lib/server/source/inventory";
import { assertSourceInventoryProjectLimit } from "$lib/server/source/inventory";
import { getSourceProviderAdapter } from "$lib/source-provider";
import { encodeGitLabPath, GitLabApiError, type GitLabClient } from "./client";

interface GitLabProjectStatistics {
  repository_size?: unknown;
  storage_size?: unknown;
  lfs_objects_size?: unknown;
  packages_size?: unknown;
  wiki_size?: unknown;
  uploads_size?: unknown;
}

interface GitLabProjectSummary {
  id?: unknown;
  name?: unknown;
  path_with_namespace?: unknown;
  visibility?: unknown;
  archived?: unknown;
  default_branch?: unknown;
  last_activity_at?: unknown;
  statistics?: unknown;
  web_url?: unknown;
  description?: unknown;
  topics?: unknown;
  empty_repo?: unknown;
  forked_from_project?: unknown;
  issues_enabled?: unknown;
  merge_requests_enabled?: unknown;
  wiki_enabled?: unknown;
  snippets_enabled?: unknown;
  container_registry_enabled?: unknown;
}

export interface DiscoverGitLabInventoryOptions {
  signal?: AbortSignal;
  onProgress?: (progress: SourceInventoryProgress) => void;
  onPaginationComplete?: (total: number | null, itemsRead: number) => void;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) {
    throw new TypeError(`GitLab project ${field} must be a non-empty string`);
  }
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new TypeError(`GitLab project ${field} must be a string`);
  return value;
}

function nullableTimestamp(value: unknown, field: string): string | null {
  const timestamp = nullableString(value, field);
  if (timestamp !== null && !Number.isFinite(Date.parse(timestamp))) {
    throw new TypeError(`GitLab project ${field} must be an ISO timestamp`);
  }
  return timestamp;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value) {
    throw new TypeError(`GitLab project ${field} must be a non-empty string`);
  }
  return value;
}

function optionalDescription(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string") return value;
  throw new TypeError("GitLab project description must be a string or null");
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new TypeError(`GitLab project ${field} must be a boolean`);
  }
  return value;
}

function optionalTopics(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((topic) => typeof topic !== "string" || !topic)) {
    throw new TypeError("GitLab project topics must be an array of non-empty strings");
  }
  return value;
}

function optionalForkedFromPath(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("GitLab project forked_from_project must be an object");
  }
  return optionalString(
    (value as { path_with_namespace?: unknown }).path_with_namespace,
    "forked_from_project.path_with_namespace",
  );
}

function optionalFeatures(project: GitLabProjectSummary) {
  const features = {
    issues: optionalBoolean(project.issues_enabled, "issues_enabled"),
    mergeRequests: optionalBoolean(project.merge_requests_enabled, "merge_requests_enabled"),
    wiki: optionalBoolean(project.wiki_enabled, "wiki_enabled"),
    snippets: optionalBoolean(project.snippets_enabled, "snippets_enabled"),
    containerRegistry: optionalBoolean(
      project.container_registry_enabled,
      "container_registry_enabled",
    ),
  };
  const reported = Object.entries(features).filter((entry) => entry[1] !== undefined);
  return reported.length > 0 ? Object.fromEntries(reported) : undefined;
}

function visibility(value: unknown): SourceProjectInventory["visibility"] {
  if (value === "public" || value === "private" || value === "internal") return value;
  throw new TypeError("GitLab project visibility is invalid");
}

function statistic(statistics: GitLabProjectStatistics | null, field: string): NumericObservation {
  if (!statistics || !(field in statistics)) {
    return { kind: "unavailable", reason: "not-reported" };
  }
  const value = statistics[field as keyof GitLabProjectStatistics];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`GitLab project statistic ${field} must be a non-negative integer`);
  }
  return { kind: "exact", value };
}

function projectStatistics(value: unknown): GitLabProjectStatistics | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("GitLab project statistics must be an object");
  }
  return value as GitLabProjectStatistics;
}

function toProjectInventory(project: GitLabProjectSummary): SourceProjectInventory {
  const sourceId = project.id;
  if (typeof sourceId !== "number" || !Number.isSafeInteger(sourceId) || sourceId < 1) {
    throw new TypeError("GitLab project id must be a positive integer");
  }
  if (typeof project.archived !== "boolean") {
    throw new TypeError("GitLab project archived must be a boolean");
  }
  const statistics = projectStatistics(project.statistics);
  const webUrl = optionalString(project.web_url, "web_url");
  const description = optionalDescription(project.description);
  const topics = optionalTopics(project.topics);
  const emptyRepository = optionalBoolean(project.empty_repo, "empty_repo");
  const forkedFromPath = optionalForkedFromPath(project.forked_from_project);
  const features = optionalFeatures(project);
  return {
    provider: "gitlab",
    sourceId: String(sourceId),
    path: requiredString(project.path_with_namespace, "path_with_namespace"),
    name: requiredString(project.name, "name"),
    visibility: visibility(project.visibility),
    archived: project.archived,
    defaultBranch: nullableString(project.default_branch, "default_branch"),
    lastActivityAt: nullableTimestamp(project.last_activity_at, "last_activity_at"),
    repositorySizeBytes: statistic(statistics, "repository_size"),
    storageSizeBytes: statistic(statistics, "storage_size"),
    lfsObjectsSizeBytes: statistic(statistics, "lfs_objects_size"),
    packagesSizeBytes: statistic(statistics, "packages_size"),
    wikiSizeBytes: statistic(statistics, "wiki_size"),
    uploadsSizeBytes: statistic(statistics, "uploads_size"),
    providerDetails: {
      provider: "gitlab",
      ...(webUrl !== undefined ? { webUrl } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(topics !== undefined ? { topics } : {}),
      ...(emptyRepository !== undefined ? { emptyRepository } : {}),
      ...(forkedFromPath !== undefined ? { forkedFromPath } : {}),
      ...(features !== undefined ? { features } : {}),
    },
  };
}

function canonicalNamespace(namespace: string): string {
  const normalized = namespace.trim();
  if (namespace !== normalized) {
    throw new TypeError("GitLab namespace must not have surrounding whitespace");
  }
  encodeGitLabPath(normalized);
  return normalized;
}

function assertProjectScope(project: SourceProjectInventory, namespace: string): void {
  if (!project.path.startsWith(`${namespace}/`)) {
    throw new TypeError(`GitLab project ${project.path} is outside namespace ${namespace}`);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new GitLabApiError(0, "GitLab inventory discovery aborted");
}

export async function* streamGitLabInventoryPages(
  client: GitLabClient,
  namespace: string,
  options: DiscoverGitLabInventoryOptions = {},
): AsyncGenerator<SourceProjectInventory[]> {
  const normalizedNamespace = canonicalNamespace(namespace);
  const path = `/groups/${encodeGitLabPath(normalizedNamespace)}/projects`;
  const sourceIds = new Set<string>();
  const projectPaths = new Set<string>();
  let discovered = 0;
  let page = 0;

  for await (const projectPage of client.paginatePages<GitLabProjectSummary>(
    path,
    {
      include_subgroups: true,
      order_by: "path",
      per_page: 100,
      simple: false,
      sort: "asc",
      statistics: true,
      with_shared: false,
    },
    {
      signal: options.signal,
      maxItems: getSourceProviderAdapter("gitlab").inventoryProjectLimit ?? undefined,
      maxItemsLabel: "project",
      onPaginationComplete: options.onPaginationComplete,
    },
  )) {
    if (projectPage.length > 100) throw new TypeError("GitLab project page exceeds 100 items");
    const projects = projectPage.map(toProjectInventory);
    for (const project of projects) {
      assertProjectScope(project, normalizedNamespace);
      if (sourceIds.has(project.sourceId) || projectPaths.has(project.path)) {
        throw new TypeError(`GitLab inventory contains duplicate project ${project.path}`);
      }
      sourceIds.add(project.sourceId);
      projectPaths.add(project.path);
    }
    page += 1;
    discovered += projects.length;
    assertSourceInventoryProjectLimit("gitlab", discovered);
    options.onProgress?.({
      provider: "gitlab",
      namespace: normalizedNamespace,
      discovered,
      page,
    });
    throwIfAborted(options.signal);
    yield projects;
  }
  throwIfAborted(options.signal);
}

export async function discoverGitLabInventory(
  client: GitLabClient,
  namespace: string,
  options: DiscoverGitLabInventoryOptions = {},
): Promise<SourceNamespaceInventory> {
  const normalizedNamespace = canonicalNamespace(namespace);
  const projects: SourceProjectInventory[] = [];
  let reportedTotal: number | null = null;
  let pagesRead = 0;
  try {
    for await (const projectPage of streamGitLabInventoryPages(client, normalizedNamespace, {
      ...options,
      onProgress: (progress) => {
        pagesRead = progress.page;
        options.onProgress?.(progress);
      },
      onPaginationComplete: (total) => {
        reportedTotal = total;
      },
    })) {
      projects.push(...projectPage);
    }
  } catch (error) {
    if (projects.length === 0 && error instanceof GitLabApiError) {
      const reason =
        error.status === 403 ? "forbidden" : error.status === 404 ? "not-found-or-hidden" : null;
      if (reason) {
        return {
          version: 1,
          provider: "gitlab",
          sourceApiUrl: client.apiUrl,
          namespace: normalizedNamespace,
          projectCount: { kind: "unavailable", reason },
          projects: [],
        };
      }
    }
    throw error;
  }

  return {
    version: 1,
    provider: "gitlab",
    sourceApiUrl: client.apiUrl,
    namespace: normalizedNamespace,
    // GitLab offset pagination is not snapshot-isolated. A stable single page
    // can be exact, but any multi-page traversal is only the observed lower
    // bound even when X-Total reconciles; missing totals are likewise bounded.
    projectCount:
      (reportedTotal === null || pagesRead > 1) && projects.length > 0
        ? { kind: "at-least", value: projects.length }
        : { kind: "exact", value: projects.length },
    projects: projects.sort(
      (left, right) =>
        left.path.localeCompare(right.path) || left.sourceId.localeCompare(right.sourceId),
    ),
  };
}
