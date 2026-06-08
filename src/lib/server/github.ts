/**
 * GitHub API interactions using Octokit.
 * Replaces pkg/ghes/, pkg/ghec/, pkg/http/.
 */

import { Agent } from "node:https";
import { createAppAuth } from "@octokit/auth-app";
import type { graphql } from "@octokit/graphql";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { Octokit } from "@octokit/rest";
import { sleep } from "$lib/server/util";
import type { AuthInput, Counts } from "$lib/types";

const RetryOctokit = Octokit.plugin(retry, throttling);

export interface GitHubClients {
  source: InstanceType<typeof RetryOctokit>;
  sourceGraphql: typeof graphql;
  target: InstanceType<typeof RetryOctokit>;
  targetGraphql: typeof graphql;
  /** Get a fresh source token (auto-refreshes for GitHub App auth). */
  getSourceToken: () => Promise<string>;
  /** Get a fresh target token (auto-refreshes for GitHub App auth). */
  getTargetToken: () => Promise<string>;
}

/**
 * Build an Octokit instance + a token-getter function for one side.
 * When GitHub App credentials are provided, Octokit uses `createAppAuth`
 * as its auth strategy — installation tokens are auto-refreshed on every
 * request, eliminating the 60-minute expiry problem for long-running
 * migrations.
 */
/** Options forwarded to the @octokit/plugin-throttling constructor. */
interface ThrottleOptions {
  onRateLimit: (
    retryAfter: number,
    options: Record<string, unknown>,
    octokit: unknown,
    retryCount: number,
  ) => boolean;
  onSecondaryRateLimit: (
    retryAfter: number,
    options: Record<string, unknown>,
    octokit: unknown,
    retryCount: number,
  ) => boolean;
}

/** Default throttling behaviour: log and retry up to 3 times on rate limits. */
function makeThrottleOptions(): ThrottleOptions {
  return {
    onRateLimit: (retryAfter, options, _octokit, retryCount) => {
      console.warn(
        `Rate limit hit for ${options.url}, retrying after ${retryAfter}s (attempt ${retryCount + 1})`,
      );
      return retryCount < 3;
    },
    onSecondaryRateLimit: (retryAfter, options, _octokit, retryCount) => {
      console.warn(`Secondary rate limit for ${options.url}, retrying after ${retryAfter}s`);
      return retryCount < 3;
    },
  };
}

function buildSide(
  auth: AuthInput,
  baseUrl: string,
  throttleOpts: ThrottleOptions,
  requestOpts?: { agent: InstanceType<typeof Agent> },
): {
  client: InstanceType<typeof RetryOctokit>;
  getToken: () => Promise<string>;
} {
  if (auth.appId) {
    // GitHub App — auto-refreshing installation tokens.
    const appCredentials = {
      appId: auth.appId,
      privateKey: auth.privateKey,
      installationId: auth.installationId,
    };
    const client = new RetryOctokit({
      authStrategy: createAppAuth,
      auth: appCredentials,
      baseUrl,
      throttle: throttleOpts,
      request: requestOpts,
    });
    return {
      client,
      // Reuse Octokit's internal auth hook for on-demand token resolution
      // (e.g. for GraphQL mutation variables that embed tokens).
      // This shares the same token cache — no duplicate API calls.
      getToken: async () => {
        const { token } = (await client.auth({ type: "installation" })) as {
          token: string;
        };
        return token;
      },
    };
  }

  // Static PAT — no refresh needed.
  if (!auth.token) throw new Error("PAT auth requires a token");
  const token = auth.token;
  return {
    client: new RetryOctokit({
      auth: token,
      baseUrl,
      throttle: throttleOpts,
      request: requestOpts,
    }),
    getToken: async () => token,
  };
}

/** Create authenticated Octokit clients for source and target. */
export function createClients(opts: {
  sourceApiUrl: string;
  sourceAuth: AuthInput;
  targetApiUrl?: string;
  targetAuth: AuthInput;
  noSslVerify?: boolean;
}): GitHubClients {
  const throttleOpts = makeThrottleOptions();

  const srcBaseUrl = normalizeApiUrl(opts.sourceApiUrl);

  // Create an HTTPS agent that skips certificate validation for self-signed certs.
  const insecureAgent = opts.noSslVerify ? new Agent({ rejectUnauthorized: false }) : undefined;
  if (insecureAgent) {
    console.warn(
      "[github] SSL verification disabled for source — accepting self-signed certificates",
    );
  }

  const srcSide = buildSide(
    opts.sourceAuth,
    srcBaseUrl,
    throttleOpts,
    insecureAgent ? { agent: insecureAgent } : undefined,
  );

  const tgtBaseUrl = opts.targetApiUrl || "https://api.github.com";
  const tgtSide = buildSide(opts.targetAuth, tgtBaseUrl, throttleOpts);

  return {
    source: srcSide.client,
    sourceGraphql: srcSide.client.graphql as typeof graphql,
    target: tgtSide.client,
    targetGraphql: tgtSide.client.graphql as typeof graphql,
    getSourceToken: srcSide.getToken,
    getTargetToken: tgtSide.getToken,
  };
}

/**
 * Create a standalone Octokit client for a single side — used when you only
 * need one side (e.g. rate limit checks) without constructing a full pair.
 */
export function createSingleClient(
  auth: AuthInput,
  baseUrl: string,
): InstanceType<typeof RetryOctokit> {
  return buildSide(auth, normalizeApiUrl(baseUrl), makeThrottleOptions()).client;
}

// ── GHES operations ────────────────────────────────────────────────────────

/** Response shape for GHES /api/v3/meta. */
interface GhesMetaResponse {
  installed_version: string;
}

/** Response shape for GHES migration create/get. */
interface GhesMigrationResponse {
  id: number;
  state: string;
}

const MIN_GHES_VERSION = "3.8.0";

export async function checkGhesVersion(client: InstanceType<typeof RetryOctokit>): Promise<string> {
  const { data } = await client.request("GET /api/v3/meta");
  const version = (data as GhesMetaResponse).installed_version;
  if (!version) throw new Error("Could not determine GHES version");
  if (!isVersionAtLeast(version, MIN_GHES_VERSION)) {
    throw new Error(`GHES version ${version} is below minimum required ${MIN_GHES_VERSION}`);
  }
  return version;
}

export async function startGitArchiveExport(
  client: InstanceType<typeof RetryOctokit>,
  org: string,
  repo: string,
): Promise<number> {
  const { data } = await client.request("POST /api/v3/orgs/{org}/migrations", {
    org,
    repositories: [repo],
    exclude_metadata: true,
  });
  return (data as GhesMigrationResponse).id;
}

export async function startMetadataArchiveExport(
  client: InstanceType<typeof RetryOctokit>,
  org: string,
  repo: string,
  skipReleases: boolean,
  lockSource: boolean,
): Promise<number> {
  const { data } = await client.request("POST /api/v3/orgs/{org}/migrations", {
    org,
    repositories: [repo],
    exclude_git_data: true,
    exclude_releases: skipReleases,
    lock_repositories: lockSource,
    exclude_owner_projects: true,
  });
  return (data as GhesMigrationResponse).id;
}

export async function getArchiveStatus(
  client: InstanceType<typeof RetryOctokit>,
  org: string,
  archiveId: number,
): Promise<string> {
  const { data } = await client.request("GET /api/v3/orgs/{org}/migrations/{migration_id}", {
    org,
    migration_id: archiveId,
  });
  return (data as GhesMigrationResponse).state;
}

export async function getArchiveUrl(
  client: InstanceType<typeof RetryOctokit>,
  org: string,
  archiveId: number,
): Promise<string> {
  const { data } = await client.request(
    "GET /api/v3/orgs/{org}/migrations/{migration_id}/archive",
    {
      org,
      migration_id: archiveId,
    },
  );
  return typeof data === "string" ? data.trim() : "";
}

export async function waitForArchive(
  client: InstanceType<typeof RetryOctokit>,
  org: string,
  archiveId: number,
  signal?: AbortSignal,
  pollInterval = 60_000,
  maxWaitMs = 2 * 60 * 60 * 1000, // 2 hours default
): Promise<string> {
  const deadline = Date.now() + maxWaitMs;
  while (!signal?.aborted) {
    const status = await getArchiveStatus(client, org, archiveId);
    if (status === "exported") return getArchiveUrl(client, org, archiveId);
    if (status === "failed") throw new Error(`Archive export ${archiveId} failed`);
    if (Date.now() >= deadline) {
      throw new Error(
        `Archive export ${archiveId} timed out after ${Math.round(maxWaitMs / 60_000)} minutes`,
      );
    }
    await sleep(pollInterval, signal);
  }
  throw new Error("Archive wait aborted");
}

// ── GHEC operations ────────────────────────────────────────────────────────

export async function doesOrgExist(
  client: InstanceType<typeof RetryOctokit>,
  org: string,
): Promise<boolean> {
  try {
    await client.orgs.get({ org });
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "status" in error &&
      (error as { status: number }).status === 404
    ) {
      return false;
    }
    throw error;
  }
}

export async function doesRepoExist(
  client: InstanceType<typeof RetryOctokit>,
  owner: string,
  repo: string,
): Promise<boolean> {
  try {
    await client.repos.get({ owner, repo });
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "status" in error &&
      (error as { status: number }).status === 404
    ) {
      return false;
    }
    throw error;
  }
}

export async function getOrgId(gql: typeof graphql, org: string): Promise<string> {
  const result = await gql<{ organization: { id: string } }>(
    `query($login: String!) { organization(login: $login) { id } }`,
    { login: org },
  );
  return result.organization.id;
}

export async function getOrgDatabaseId(gql: typeof graphql, org: string): Promise<string> {
  const result = await gql<{ organization: { databaseId: number } }>(
    `query($login: String!) { organization(login: $login) { databaseId } }`,
    { login: org },
  );
  return String(result.organization.databaseId);
}

export async function createMigrationSource(gql: typeof graphql, orgId: string): Promise<string> {
  const result = await gql<{ createMigrationSource: { migrationSource: { id: string } } }>(
    `mutation($name: String!, $sourceUrl: String!, $ownerId: ID!, $type: MigrationSourceType!) {
			createMigrationSource(input: { name: $name, url: $sourceUrl, ownerId: $ownerId, type: $type }) {
				migrationSource { id }
			}
		}`,
    {
      name: "GHEC Source",
      sourceUrl: "https://github.com",
      ownerId: orgId,
      type: "GITHUB_ARCHIVE",
    },
  );
  return result.createMigrationSource.migrationSource.id;
}

export interface StartMigrationOpts {
  migrationSourceId: string;
  sourceRepoUrl: string;
  orgId: string;
  repoName: string;
  sourceToken: string;
  targetToken: string;
  gitArchiveUrl: string;
  metadataArchiveUrl: string;
  skipReleases?: boolean;
  targetRepoVisibility?: string;
  lockSource?: boolean;
}

export async function startMigration(
  gql: typeof graphql,
  opts: StartMigrationOpts,
): Promise<string> {
  const mutation = `mutation startRepositoryMigration(
		$sourceId: ID!, $ownerId: ID!, $sourceRepositoryUrl: URI!,
		$repositoryName: String!, $continueOnError: Boolean!,
		$gitArchiveUrl: String, $metadataArchiveUrl: String,
		$accessToken: String!, $githubPat: String, $skipReleases: Boolean,
		$targetRepoVisibility: String, $lockSource: Boolean
	) {
		startRepositoryMigration(input: {
			sourceId: $sourceId, ownerId: $ownerId,
			sourceRepositoryUrl: $sourceRepositoryUrl,
			repositoryName: $repositoryName, continueOnError: $continueOnError,
			gitArchiveUrl: $gitArchiveUrl, metadataArchiveUrl: $metadataArchiveUrl,
			accessToken: $accessToken, githubPat: $githubPat,
			skipReleases: $skipReleases, targetRepoVisibility: $targetRepoVisibility, lockSource: $lockSource
		}) {
			repositoryMigration { id }
		}
	}`;

  const variables: Record<string, unknown> = {
    sourceId: opts.migrationSourceId,
    ownerId: opts.orgId,
    sourceRepositoryUrl: opts.sourceRepoUrl,
    repositoryName: opts.repoName,
    continueOnError: true,
    gitArchiveUrl: opts.gitArchiveUrl || null,
    metadataArchiveUrl: opts.metadataArchiveUrl || null,
    accessToken: opts.sourceToken,
    githubPat: opts.targetToken,
    skipReleases: opts.skipReleases ?? false,
    targetRepoVisibility: opts.targetRepoVisibility || null,
    lockSource: opts.lockSource ?? false,
  };

  const result = await gql<{
    startRepositoryMigration: { repositoryMigration: { id: string } };
  }>(mutation, variables);
  return result.startRepositoryMigration.repositoryMigration.id;
}

export interface GhecMigration {
  state: string;
  repositoryName: string;
  warningsCount: number;
  failureReason: string;
  migrationLogUrl: string;
}

export async function getMigration(
  gql: typeof graphql,
  migrationId: string,
): Promise<GhecMigration> {
  const result = await gql<{ node: GhecMigration }>(
    `query($id: ID!) {
			node(id: $id) {
				... on Migration {
					id, sourceUrl, migrationLogUrl,
					migrationSource { name },
					state, warningsCount, failureReason, repositoryName
				}
			}
		}`,
    { id: migrationId },
  );
  return result.node;
}

export async function abortMigration(gql: typeof graphql, migrationId: string): Promise<boolean> {
  const result = await gql<{ abortRepositoryMigration: { success: boolean } }>(
    `mutation($migrationId: ID!) {
			abortRepositoryMigration(input: { migrationId: $migrationId }) { success }
		}`,
    { migrationId },
  );
  return result.abortRepositoryMigration.success;
}

// ── Repo counts (for progress) ────────────────────────────────────────────

export async function getRepoCounts(
  client: InstanceType<typeof RetryOctokit>,
  gql: typeof graphql,
  owner: string,
  repo: string,
): Promise<Counts> {
  const [gqlResult, commits] = await Promise.all([
    gql<{
      repository: {
        refs: { totalCount: number };
        tags: { totalCount: number };
        issues: { totalCount: number };
        pullRequests: { totalCount: number };
        releases: { totalCount: number };
      };
    }>(
      `query repoCounts($owner: String!, $repo: String!) {
        repository(owner: $owner, name: $repo) {
          refs(refPrefix: "refs/heads/") { totalCount }
          tags: refs(refPrefix: "refs/tags/") { totalCount }
          issues(states: [OPEN, CLOSED]) { totalCount }
          pullRequests(states: [OPEN, CLOSED, MERGED]) { totalCount }
          releases { totalCount }
        }
      }`,
      { owner, repo },
    ).catch(() => null),
    getResourceCount(client, owner, repo, "commits"),
  ]);

  if (gqlResult) {
    return {
      commits,
      branches: gqlResult.repository.refs.totalCount,
      tags: gqlResult.repository.tags.totalCount,
      issues: gqlResult.repository.issues.totalCount,
      pullRequests: gqlResult.repository.pullRequests.totalCount,
      releases: gqlResult.repository.releases.totalCount,
    };
  }
  // Fallback: if GraphQL fails, zero out the non-commit fields
  return { commits, branches: 0, tags: 0, issues: 0, pullRequests: 0, releases: 0 };
}

async function getResourceCount(
  client: InstanceType<typeof RetryOctokit>,
  owner: string,
  repo: string,
  resource: string,
): Promise<number> {
  try {
    const params: Record<string, unknown> = { owner, repo, per_page: 1 };

    const response = await client.request(`GET /repos/{owner}/{repo}/${resource}`, params);
    const link = response.headers.link;
    if (link) {
      const match = link.match(/page=(\d+)>;\s*rel="last"/);
      if (match) return parseInt(match[1], 10);
    }
    return Array.isArray(response.data) ? response.data.length : 0;
  } catch {
    return 0;
  }
}

// ── Archive source repo ────────────────────────────────────────────────────

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  resetAt: string;
}

export async function getRateLimit(
  client: InstanceType<typeof RetryOctokit>,
): Promise<RateLimitInfo> {
  const { data } = await client.request("GET /rate_limit");
  const core = (
    data as {
      resources: { core: { limit: number; remaining: number; reset: number } };
    }
  ).resources.core;
  return {
    limit: core.limit,
    remaining: core.remaining,
    resetAt: new Date(core.reset * 1000).toISOString(),
  };
}

export async function getRepoNodeId(
  gql: typeof graphql,
  owner: string,
  name: string,
): Promise<string> {
  const result = await gql<{ repository: { id: string } }>(
    `query($owner: String!, $name: String!) {
			repository(owner: $owner, name: $name) { id }
		}`,
    { owner, name },
  );
  return result.repository.id;
}

export async function archiveRepository(gql: typeof graphql, repoNodeId: string): Promise<boolean> {
  const result = await gql<{ archiveRepository: { repository: { isArchived: boolean } } }>(
    `mutation($repositoryId: ID!) {
			archiveRepository(input: { repositoryId: $repositoryId }) {
				repository { isArchived }
			}
		}`,
    { repositoryId: repoNodeId },
  );
  return result.archiveRepository.repository.isArchived;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Check if a URL points to the github.com API (not a GHES instance). */
function isGitHubDotCom(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return hostname === "api.github.com" || hostname === "github.com";
  } catch {
    return url.includes("api.github.com");
  }
}

function normalizeApiUrl(url: string): string {
  url = url.replace(/\/+$/, "");
  // GHES: https://ghes.example.com → https://ghes.example.com/api/v3
  if (!isGitHubDotCom(url) && !url.endsWith("/api/v3")) {
    return `${url}/api/v3`;
  }
  return url;
}

export function sourceBaseUrl(apiUrl: string): string {
  if (isGitHubDotCom(apiUrl)) return "https://github.com";
  const u = apiUrl.replace(/\/+$/, "");
  if (u.endsWith("/api/v3")) return u.replace(/\/api\/v3$/, "");
  if (u.includes("://api.")) return u.replace("://api.", "://");
  return u;
}

export function isGhecSource(apiUrl: string): boolean {
  return isGitHubDotCom(apiUrl);
}

function isVersionAtLeast(version: string, min: string): boolean {
  const v = version.split(".").map(Number);
  const m = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((v[i] ?? 0) > (m[i] ?? 0)) return true;
    if ((v[i] ?? 0) < (m[i] ?? 0)) return false;
  }
  return true;
}

// Re-export shared sleep utility.
export { sleep } from "$lib/server/util";
