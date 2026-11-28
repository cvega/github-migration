import { safeErrorReason } from "$lib/server/core/safe-error";
import type {
  NumericObservation,
  SourceInventoryProgress,
  SourceNamespaceInventory,
  SourceProjectInventory,
} from "$lib/server/source/inventory";
import { assertSourceInventoryProjectLimit } from "$lib/server/source/inventory";
import { getSourceProviderAdapter } from "$lib/source-provider";
import {
  BitbucketFileNotFoundError,
  BitbucketServerApiError,
  type BitbucketServerClient,
  encodeBitbucketSegment,
} from "./client";

interface BitbucketApplicationProperties {
  version?: unknown;
}

interface BitbucketBranch {
  displayId?: unknown;
}

interface BitbucketRepositorySummary {
  id?: unknown;
  slug?: unknown;
  name?: unknown;
  public?: unknown;
  archived?: unknown;
  state?: unknown;
  defaultBranch?: unknown;
  updatedDate?: unknown;
  size?: unknown;
  description?: unknown;
  scmId?: unknown;
  forkable?: unknown;
  origin?: unknown;
  links?: unknown;
}

export interface DiscoverBitbucketInventoryOptions {
  includeStorage?: boolean;
  checkLfs?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: SourceInventoryProgress) => void;
}

const MINIMUM_BITBUCKET_SERVER_VERSION = "5.14.0";

function versionParts(value: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(value);
  if (!match) throw new TypeError("Bitbucket Server version was invalid");
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

function isVersionAtLeast(value: string, minimum: string): boolean {
  const current = versionParts(value);
  const required = versionParts(minimum);
  for (let index = 0; index < current.length; index += 1) {
    if (current[index] !== required[index]) return (current[index] ?? 0) > (required[index] ?? 0);
  }
  return true;
}

export async function assertSupportedBitbucketServerVersion(
  client: BitbucketServerClient,
  signal?: AbortSignal,
): Promise<string> {
  const properties = await client.get<BitbucketApplicationProperties>(
    "/application-properties",
    {},
    { signal },
  );
  if (typeof properties.version !== "string" || !properties.version) {
    throw new TypeError("Bitbucket Server version was not reported");
  }
  if (!isVersionAtLeast(properties.version, MINIMUM_BITBUCKET_SERVER_VERSION)) {
    throw new TypeError(
      `Bitbucket Server ${properties.version} is below the minimum supported version ${MINIMUM_BITBUCKET_SERVER_VERSION}`,
    );
  }
  return properties.version;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) {
    throw new TypeError(`Bitbucket repository ${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredString(value, field);
}

function optionalDescription(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string") return value;
  throw new TypeError("Bitbucket repository description must be a string or null");
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new TypeError(`Bitbucket repository ${field} must be a boolean`);
  }
  return value;
}

function optionalWebUrl(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Bitbucket repository links must be an object");
  }
  const self = (value as { self?: unknown }).self;
  if (self === undefined || self === null) return undefined;
  if (!Array.isArray(self) || self.length === 0) {
    throw new TypeError("Bitbucket repository links.self must be a non-empty array");
  }
  const first = self[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) {
    throw new TypeError("Bitbucket repository links.self must contain link objects");
  }
  return requiredString((first as { href?: unknown }).href, "links.self.href");
}

function optionalForkedFromPath(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Bitbucket repository origin must be an object");
  }
  const origin = value as { slug?: unknown; project?: unknown };
  if (!origin.project || typeof origin.project !== "object" || Array.isArray(origin.project)) {
    throw new TypeError("Bitbucket repository origin.project must be an object");
  }
  const projectKey = requiredString(
    (origin.project as { key?: unknown }).key,
    "origin.project.key",
  );
  return `${projectKey}/${requiredString(origin.slug, "origin.slug")}`;
}

function optionalTimestamp(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  const date = typeof value === "number" ? new Date(value) : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError(`Bitbucket repository ${field} must be a timestamp`);
  }
  return date.toISOString();
}

function optionalSize(value: unknown): NumericObservation {
  if (value === undefined || value === null) {
    return { kind: "unavailable", reason: "not-reported" };
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Bitbucket repository size must be a non-negative integer");
  }
  return { kind: "exact", value };
}

function defaultBranch(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Bitbucket repository defaultBranch must be an object");
  }
  const displayId = (value as BitbucketBranch).displayId;
  if (displayId === undefined || displayId === null) return null;
  return requiredString(displayId, "defaultBranch.displayId");
}

function toProjectInventory(
  repository: BitbucketRepositorySummary,
  projectKey: string,
): SourceProjectInventory {
  const sourceId = repository.id;
  if (typeof sourceId !== "number" || !Number.isSafeInteger(sourceId) || sourceId < 1) {
    throw new TypeError("Bitbucket repository id must be a positive integer");
  }
  if (typeof repository.public !== "boolean") {
    throw new TypeError("Bitbucket repository public must be a boolean");
  }
  if (repository.archived !== undefined && typeof repository.archived !== "boolean") {
    throw new TypeError("Bitbucket repository archived must be a boolean");
  }
  if (repository.state !== undefined && typeof repository.state !== "string") {
    throw new TypeError("Bitbucket repository state must be a string");
  }
  const slug = requiredString(repository.slug, "slug");
  const repositorySize = optionalSize(repository.size);
  const unavailable: NumericObservation = { kind: "unavailable", reason: "not-reported" };
  const webUrl = optionalWebUrl(repository.links);
  const description = optionalDescription(repository.description);
  const scmId = optionalString(repository.scmId, "scmId");
  const forkable = optionalBoolean(repository.forkable, "forkable");
  const forkedFromPath = optionalForkedFromPath(repository.origin);
  const state = optionalString(repository.state, "state");
  return {
    provider: "bitbucket-server",
    sourceId: String(sourceId),
    path: `${projectKey}/${slug}`,
    name: requiredString(repository.name, "name"),
    visibility: repository.public ? "public" : "private",
    archived: repository.archived === true || repository.state?.toUpperCase() === "ARCHIVED",
    defaultBranch: defaultBranch(repository.defaultBranch),
    lastActivityAt: optionalTimestamp(repository.updatedDate, "updatedDate"),
    repositorySizeBytes: repositorySize,
    storageSizeBytes: unavailable,
    lfsObjectsSizeBytes: unavailable,
    packagesSizeBytes: unavailable,
    wikiSizeBytes: unavailable,
    uploadsSizeBytes: unavailable,
    jobArtifactsSizeBytes: { kind: "unavailable", reason: "unsupported" },
    pipelineArtifactsSizeBytes: { kind: "unavailable", reason: "unsupported" },
    snippetsSizeBytes: { kind: "unavailable", reason: "unsupported" },
    containerRegistrySizeBytes: { kind: "unavailable", reason: "unsupported" },
    providerDetails: {
      provider: "bitbucket-server",
      ...(webUrl !== undefined ? { webUrl } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(scmId !== undefined ? { scmId } : {}),
      ...(forkable !== undefined ? { forkable } : {}),
      ...(forkedFromPath !== undefined ? { forkedFromPath } : {}),
      ...(state !== undefined ? { state } : {}),
    },
  };
}

function canonicalProjectKey(projectKey: string): string {
  const normalized = projectKey.trim();
  const adapter = getSourceProviderAdapter("bitbucket-server");
  if (normalized !== projectKey || !adapter.isValidNamespace(normalized)) {
    throw new TypeError("Bitbucket project key is invalid");
  }
  return normalized;
}

async function rootLfsRules(
  client: BitbucketServerClient,
  project: string,
  slug: string,
  branch: string | null,
  signal?: AbortSignal,
): Promise<"found" | "none" | "unknown"> {
  if (!branch) return "unknown";
  try {
    const page = await client.get<{ lines?: Array<{ text?: string }>; isLastPage?: boolean }>(
      `/projects/${encodeBitbucketSegment(project, "project key")}/repos/${encodeBitbucketSegment(slug, "repository slug")}/browse/.gitattributes`,
      { at: `refs/heads/${branch}`, limit: 100 },
      { signal, distinguishMissingFile: true },
    );
    if (!Array.isArray(page?.lines) || !page.lines.every((line) => typeof line?.text === "string"))
      return "unknown";
    for (const { text } of page.lines) {
      const line = text?.trim();
      if (!line || line.startsWith("#") || line.startsWith("[attr]")) continue;
      if (/^(?:"(?:\\.|[^"\\])*"|[^\s"]+)\s+(?:\S+\s+)*filter=lfs(?:\s|$)/.test(line))
        return "found";
    }
    return page.isLastPage === true ? "none" : "unknown";
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof BitbucketFileNotFoundError) return "none";
    if (!(error instanceof BitbucketServerApiError)) throw error;
    return "unknown";
  }
}

export async function* streamBitbucketInventoryPages(
  client: BitbucketServerClient,
  projectKey: string,
  options: DiscoverBitbucketInventoryOptions = {},
): AsyncGenerator<SourceProjectInventory[]> {
  const canonicalKey = canonicalProjectKey(projectKey);
  const sourceIds = new Set<string>();
  const paths = new Set<string>();
  let page = 0;
  let discovered = 0;

  for await (const repositoryPage of client.paginatePages<BitbucketRepositorySummary>(
    `/projects/${encodeBitbucketSegment(canonicalKey, "project key")}/repos`,
    { limit: 100 },
    {
      signal: options.signal,
      maxItems: getSourceProviderAdapter("bitbucket-server").inventoryProjectLimit ?? undefined,
      maxItemsLabel: "repository",
    },
  )) {
    const projects = repositoryPage.map((repository) =>
      toProjectInventory(repository, canonicalKey),
    );
    for (const [index, project] of projects.entries()) {
      const canonicalPath = project.path.toLowerCase();
      if (sourceIds.has(project.sourceId) || paths.has(canonicalPath)) {
        throw new TypeError(`Bitbucket inventory contains duplicate repository ${project.path}`);
      }
      sourceIds.add(project.sourceId);
      paths.add(canonicalPath);
      if (options.includeStorage) {
        const slug = requiredString(repositoryPage[index]?.slug, "slug");
        try {
          const sizes = await client.getRepositorySizes(canonicalKey, slug, options.signal);
          if (!sizes || typeof sizes !== "object")
            throw new TypeError("Expected repository size details");
          if ("repository" in sizes && sizes.repository != null)
            project.repositorySizeBytes = optionalSize(sizes.repository);
          if ("attachments" in sizes) project.uploadsSizeBytes = optionalSize(sizes.attachments);
        } catch (error) {
          options.signal?.throwIfAborted();
          if (!(error instanceof BitbucketServerApiError || error instanceof TypeError))
            throw error;
          const reason =
            error instanceof BitbucketServerApiError && [401, 403].includes(error.status)
              ? "forbidden"
              : "not-reported";
          project.uploadsSizeBytes = { kind: "unavailable", reason };
          if (project.repositorySizeBytes.kind === "unavailable")
            project.repositorySizeBytes = { kind: "unavailable", reason };
          console.warn(
            safeErrorReason(
              error,
              `[profile] Bitbucket size details unavailable for ${project.path}`,
            ),
          );
        }
      }
      if (repositoryPage[index]?.defaultBranch === undefined) {
        const repositorySlug = requiredString(repositoryPage[index]?.slug, "slug");
        try {
          project.defaultBranch = defaultBranch(
            await client.get(
              `/projects/${encodeBitbucketSegment(canonicalKey, "project key")}/repos/${encodeBitbucketSegment(repositorySlug, "repository slug")}/default-branch`,
              {},
              { signal: options.signal },
            ),
          );
        } catch (error) {
          if (!(error instanceof BitbucketServerApiError && [401, 403, 404].includes(error.status)))
            throw error;
        }
      }
    }
    if (options.checkLfs) {
      for (const [index, project] of projects.entries()) {
        if (project.providerDetails?.provider === "bitbucket-server") {
          project.providerDetails.rootLfsRules = await rootLfsRules(
            client,
            canonicalKey,
            requiredString(repositoryPage[index]?.slug, "slug"),
            project.defaultBranch,
            options.signal,
          );
        }
      }
    }
    page += 1;
    discovered += projects.length;
    assertSourceInventoryProjectLimit("bitbucket-server", discovered);
    options.onProgress?.({
      provider: "bitbucket-server",
      namespace: canonicalKey,
      discovered,
      page,
    });
    options.signal?.throwIfAborted();
    yield projects;
  }
}

export async function discoverBitbucketInventory(
  client: BitbucketServerClient,
  projectKey: string,
  options: DiscoverBitbucketInventoryOptions = {},
): Promise<SourceNamespaceInventory> {
  const canonicalKey = canonicalProjectKey(projectKey);
  await assertSupportedBitbucketServerVersion(client, options.signal);
  const projects: SourceProjectInventory[] = [];
  try {
    for await (const page of streamBitbucketInventoryPages(client, canonicalKey, options)) {
      projects.push(...page);
    }
  } catch (error) {
    if (projects.length === 0 && error instanceof BitbucketServerApiError) {
      const reason =
        error.status === 403 ? "forbidden" : error.status === 404 ? "not-found-or-hidden" : null;
      if (reason) {
        return {
          version: 1,
          provider: "bitbucket-server",
          sourceApiUrl: client.apiUrl,
          namespace: canonicalKey,
          projectCount: { kind: "unavailable", reason },
          projects: [],
        };
      }
    }
    throw error;
  }

  return {
    version: 1,
    provider: "bitbucket-server",
    sourceApiUrl: client.apiUrl,
    namespace: canonicalKey,
    // The pager returns only after an authoritative isLastPage=true response;
    // repeated cursors, invalid nextPageStart, and page/item ceilings throw.
    projectCount: { kind: "exact", value: projects.length },
    projects: projects.sort(
      (left, right) =>
        left.path.localeCompare(right.path, undefined, { sensitivity: "base" }) ||
        left.sourceId.localeCompare(right.sourceId),
    ),
  };
}
