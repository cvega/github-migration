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
import type { AuthInput, Counts } from "$lib/migrate/types";
import { getGitHubSourcePlatform } from "$lib/source-provider";
import { parseSourceApiUrl } from "./source-url";

export { sourceBaseUrl } from "$lib/source-provider";

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

  const srcBaseUrl = normalizeGitHubApiUrl(opts.sourceApiUrl);

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
  return buildSide(auth, normalizeGitHubApiUrl(baseUrl), makeThrottleOptions()).client;
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
  const link = res.headers?.link;
  if (typeof link === "string") {
    // The header is a comma-separated list of `<url>; rel="…"` parts. Find the
    // `last` part and read its `page=N` query param (position-independent).
    const last = link.split(",").find((part) => /\brel="last"/.test(part));
    const page = Number(last?.match(/[?&]page=(\d+)(?:[&>]|$)/)?.[1]);
    if (Number.isSafeInteger(page) && page > 0) return page;
    if (last || /\brel="next"/.test(link))
      throw new Error(`Cannot determine count from pagination for ${route}`);
  }
  if (!Array.isArray(res.data)) throw new Error(`Invalid count response for ${route}`);
  return res.data.length;
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
    ),
    getResourceCount(client, owner, repo, "commits"),
  ]);

  const counts = {
    commits,
    branches: gqlResult.repository.refs.totalCount,
    tags: gqlResult.repository.tags.totalCount,
    issues: gqlResult.repository.issues.totalCount,
    pullRequests: gqlResult.repository.pullRequests.totalCount,
    releases: gqlResult.repository.releases.totalCount,
  };
  if (!Object.values(counts).every((count) => Number.isSafeInteger(count) && count >= 0)) {
    throw new Error("Invalid repository counts returned by GitHub");
  }
  return counts;
}

async function getResourceCount(
  client: InstanceType<typeof RetryOctokit>,
  owner: string,
  repo: string,
  resource: string,
): Promise<number> {
  try {
    return await countByPagination(client, `GET /repos/{owner}/{repo}/${resource}`, {
      owner,
      repo,
    });
  } catch (error) {
    if (
      resource === "commits" &&
      error instanceof Error &&
      "status" in error &&
      error.status === 409
    ) {
      return 0;
    }
    throw error;
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

/**
 * True when the URL points at GitHub Enterprise Cloud rather than a GHES
 * instance. GHEC covers standard github.com AND data-residency tenants under
 * `*.ghe.com` (API host `api.<tenant>.ghe.com`). Everything else is GHES.
 *
 * This distinction drives migration behavior: cloud sources skip the GHES
 * version check and archive export, and their API URL never takes a `/api/v3`
 * path suffix.
 */
export function normalizeGitHubApiUrl(value: string): string {
  const parsed = parseSourceApiUrl(value, { label: "GitHub API URL", requireHttps: true });
  const url = parsed.toString().replace(/\/+$/, "");
  // GHES: https://ghes.example.com → https://ghes.example.com/api/v3.
  // Cloud (github.com / *.ghe.com) already uses an `api.` host and takes no path.
  if (!isGhecSource(url) && !url.endsWith("/api/v3")) {
    return `${url}/api/v3`;
  }
  return url;
}

export function isGhecSource(apiUrl: string): boolean {
  return getGitHubSourcePlatform(apiUrl) === "ghec";
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
