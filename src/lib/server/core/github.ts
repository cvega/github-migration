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
import type { AuthInput, Counts } from "$lib/types";

const RetryOctokit = Octokit.plugin(retry, throttling);

/** An authenticated Octokit client (REST + GraphQL), with retry + throttling. */
export type GitHubClient = InstanceType<typeof RetryOctokit>;

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
export function makeThrottleOptions(): ThrottleOptions {
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

// ── Repo counts (for progress) ────────────────────────────────────────────

/**
 * Count a paginated REST collection cheaply via the `Link` header.
 *
 * GitHub paginates list endpoints and advertises a `rel="last"` link whenever a
 * collection spans more than one page. Requesting a single item per page
 * (`per_page=1`) makes that last-page number equal the total item count — so one
 * request sizes the collection without walking every page or materializing every
 * object. This is the standard, protocol-level way to count commits, webhooks,
 * and the like, rather than fetching them or walking a graph (e.g. GraphQL
 * `history.totalCount`, which walks the whole commit graph and times out at
 * scale).
 *
 * When there's no `rel="last"` link the collection fits on one page, so the
 * count is the number of items actually returned (0 or 1).
 *
 * @param client REST client.
 * @param route  Octokit route, e.g. `"GET /repos/{owner}/{repo}/commits"`.
 * @param params Route + query params; `per_page` is forced to 1.
 * @returns The item count.
 */
export async function countByPagination(
  client: InstanceType<typeof RetryOctokit>,
  route: string,
  params: Record<string, string | number>,
): Promise<number> {
  const res = await client.request(route, { ...params, per_page: 1 });
  const link = res.headers.link;
  if (typeof link === "string") {
    // The header is a comma-separated list of `<url>; rel="…"` parts. Find the
    // `last` part and read its `page=N` query param (position-independent).
    for (const part of link.split(",")) {
      if (/\brel="last"/.test(part)) {
        const m = part.match(/[?&]page=(\d+)/);
        if (m?.[1]) return Number.parseInt(m[1], 10);
      }
    }
  }
  return Array.isArray(res.data) ? res.data.length : 0;
}

/**
 * Fetch a repository's disk size in kilobytes (GitHub's `size` field).
 * Returns null if the repo can't be read — callers treat this as "unknown".
 */
export async function getRepoSize(
  client: InstanceType<typeof RetryOctokit>,
  owner: string,
  repo: string,
): Promise<number | null> {
  try {
    const { data } = await client.repos.get({ owner, repo });
    return typeof data.size === "number" ? data.size : null;
  } catch {
    return null;
  }
}

/** Immutable + current identity facts for a repository, read at cleanup time. */
export interface RepoFacts {
  nodeId: string;
  owner: string;
  name: string;
  createdAt: string;
}

/**
 * Fetch the live identity facts (node_id, owner, name, created_at) of a repo.
 * Returns null if the repo doesn't exist or can't be read — callers treat that
 * as "cannot prove identity" and refuse cleanup.
 */
export async function getRepoFacts(
  client: InstanceType<typeof RetryOctokit>,
  owner: string,
  repo: string,
): Promise<RepoFacts | null> {
  try {
    const { data } = await client.repos.get({ owner, repo });
    return {
      nodeId: data.node_id,
      owner: data.owner.login,
      name: data.name,
      createdAt: typeof data.created_at === "string" ? data.created_at : "",
    };
  } catch {
    return null;
  }
}

/**
 * Rename a repository. Privileged (Administration: write). Returns the repo's
 * new full name. Reversible — the node_id is unchanged by a rename.
 */
export async function renameRepo(
  client: InstanceType<typeof RetryOctokit>,
  owner: string,
  repo: string,
  newName: string,
): Promise<string> {
  const { data } = await client.repos.update({ owner, repo, name: newName });
  return data.full_name;
}

/**
 * Delete a repository. Privileged (Administration: write) and irreversible.
 * Callers MUST have passed `evaluateCleanupEligibility` first.
 */
export async function deleteRepo(
  client: InstanceType<typeof RetryOctokit>,
  owner: string,
  repo: string,
): Promise<void> {
  await client.repos.delete({ owner, repo });
}

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
      const lastPage = link.match(/page=(\d+)>;\s*rel="last"/)?.[1];
      if (lastPage) return parseInt(lastPage, 10);
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

// ── Helpers ────────────────────────────────────────────────────────────────

/** Check if a URL points to the standard github.com API (not GHES, not GHE.com). */
function isGitHubDotCom(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return hostname === "api.github.com" || hostname === "github.com";
  } catch {
    return url.includes("api.github.com");
  }
}

/**
 * True when the URL points at GitHub Enterprise Cloud rather than a GHES
 * instance. GHEC covers standard github.com AND data-residency tenants under
 * `*.ghe.com` (API host `api.<tenant>.ghe.com`). Everything else is GHES.
 *
 * This distinction drives migration behavior: cloud sources skip the GHES
 * version check and archive export, and their API URL never takes a `/api/v3`
 * path suffix.
 */
function isCloudApiUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    if (hostname === "github.com" || hostname === "api.github.com") return true;
    return hostname === "ghe.com" || hostname.endsWith(".ghe.com");
  } catch {
    const u = url.toLowerCase();
    return u.includes("github.com") || u.includes("ghe.com");
  }
}

function normalizeApiUrl(url: string): string {
  url = url.replace(/\/+$/, "");
  // GHES: https://ghes.example.com → https://ghes.example.com/api/v3.
  // Cloud (github.com / *.ghe.com) already uses an `api.` host and takes no path.
  if (!isCloudApiUrl(url) && !url.endsWith("/api/v3")) {
    return `${url}/api/v3`;
  }
  return url;
}

export function sourceBaseUrl(apiUrl: string): string {
  // Standard GHEC → canonical web host.
  if (isGitHubDotCom(apiUrl)) return "https://github.com";
  const u = apiUrl.replace(/\/+$/, "");
  // GHES: drop the /api/v3 suffix to get the web host.
  if (u.endsWith("/api/v3")) return u.replace(/\/api\/v3$/, "");
  // Data-residency (api.<tenant>.ghe.com) and other `api.`-prefixed API hosts:
  // drop the `api.` prefix to get the web host (https://<tenant>.ghe.com).
  if (u.includes("://api.")) return u.replace("://api.", "://");
  return u;
}

export function isGhecSource(apiUrl: string): boolean {
  return isCloudApiUrl(apiUrl);
}

export function isVersionAtLeast(version: string, min: string): boolean {
  const v = version.split(".").map(Number);
  const m = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const vi = v[i] ?? 0;
    const mi = m[i] ?? 0;
    // A non-numeric version segment (NaN) means the version string is malformed
    // and we can't confirm it meets the minimum — fail closed so the GHES gate
    // rejects it rather than letting an unverifiable instance through.
    if (Number.isNaN(vi)) return false;
    if (vi > mi) return true;
    if (vi < mi) return false;
  }
  return true;
}
