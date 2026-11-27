/**
 * GitHub API interactions using Octokit.
 * Replaces pkg/ghes/, pkg/ghec/, pkg/http/.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createAppAuth } from "@octokit/auth-app";
import type { graphql } from "@octokit/graphql";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { Octokit } from "@octokit/rest";
import type { AuthInput, Counts } from "$lib/migrate/types";
import { getGitHubSourcePlatform } from "$lib/source-provider";
import { sleep } from "./polling";
import { parseSourceApiUrl } from "./source-url";

export { sourceBaseUrl } from "$lib/source-provider";

const RetryOctokit = Octokit.plugin(retry, throttling);

type GitHubFetch = (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

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

export type GitHubTargetClients = Pick<
  GitHubClients,
  "target" | "targetGraphql" | "getTargetToken"
>;

export function createTargetClients(targetAuth: AuthInput, apiUrl: string): GitHubTargetClients {
  const { client, getToken } = buildSide(targetAuth, apiUrl, makeThrottleOptions());
  return {
    target: client,
    targetGraphql: client.graphql as typeof graphql,
    getTargetToken: getToken,
  };
}

/**
 * Build an Octokit instance + a token-getter function for one side.
 * When GitHub App credentials are provided, Octokit uses `createAppAuth`
 * as its auth strategy — installation tokens are auto-refreshed on every
 * request, eliminating the 60-minute expiry problem for long-running
 * migrations.
 */
interface ThrottledRequestOptions {
  url?: string;
  request?: Record<string, unknown>;
}

/** Options forwarded to the @octokit/plugin-throttling constructor. */
interface ThrottleOptions {
  onRateLimit: (
    retryAfter: number,
    options: ThrottledRequestOptions,
    octokit: unknown,
    retryCount: number,
  ) => boolean;
  onSecondaryRateLimit: (
    retryAfter: number,
    options: ThrottledRequestOptions,
    octokit: unknown,
    retryCount: number,
  ) => boolean;
}

/** Retry rate limits up to three times unless the request opts out of retries. */
export function makeThrottleOptions(): ThrottleOptions {
  return {
    onRateLimit: (retryAfter, options, _octokit, retryCount) => {
      if (options.request?.retries === 0) return false;
      console.warn(
        `Rate limit hit for ${options.url}, retrying after ${retryAfter}s (attempt ${retryCount + 1})`,
      );
      return retryCount < 3;
    },
    onSecondaryRateLimit: (retryAfter, options, _octokit, retryCount) => {
      if (options.request?.retries === 0) return false;
      console.warn(`Secondary rate limit for ${options.url}, retrying after ${retryAfter}s`);
      return retryCount < 3;
    },
  };
}

function buildSide(
  auth: AuthInput,
  baseUrl: string,
  throttleOpts: ThrottleOptions,
  requestOpts?: { fetch: GitHubFetch },
  retryEnabled = true,
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
      retry: { enabled: retryEnabled },
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
      retry: { enabled: retryEnabled },
      request: requestOpts,
    }),
    getToken: async () => token,
  };
}

export function sourceTlsPolicyError(sourceApiUrl: string): string | null {
  const source = normalizeGitHubApiUrl(sourceApiUrl);
  for (const entry of (process.env.GH_ALLOW_INSECURE_SOURCE_TLS ?? "").split(",")) {
    try {
      if (normalizeGitHubApiUrl(entry.trim()) === source) return null;
    } catch {
      // Malformed policy entries grant no exception.
    }
  }
  return "Source TLS verification can only be disabled for an exact source approved in GH_ALLOW_INSECURE_SOURCE_TLS";
}

function approvedSourceFetch(baseUrl: string): GitHubFetch {
  const source = new URL(baseUrl);
  const apiPath = source.pathname.replace(/\/$/, "");
  // Octokit maps the GHES REST base to its sibling GraphQL endpoint.
  const graphqlPath = apiPath.replace(/\/api\/v3$/, "/api/graphql");
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const isSourceApi =
      url.origin === source.origin &&
      (url.pathname === apiPath ||
        url.pathname.startsWith(`${apiPath}/`) ||
        url.pathname === graphqlPath);
    if (!isSourceApi) return fetch(input, init);

    // Keep explicit manual redirects for GHES archive discovery.
    // Never let Fetch automatically carry the exception to another URL.
    return fetch(input, {
      ...init,
      redirect: init?.redirect === "manual" ? "manual" : "error",
      tls: { rejectUnauthorized: false },
    });
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

  const policyError = opts.noSslVerify && sourceTlsPolicyError(srcBaseUrl);
  if (policyError) throw new Error(policyError);
  if (opts.noSslVerify) {
    console.warn(
      "[github] SSL verification disabled for source — accepting self-signed certificates",
    );
  }

  const srcSide = buildSide(
    opts.sourceAuth,
    srcBaseUrl,
    throttleOpts,
    opts.noSslVerify ? { fetch: approvedSourceFetch(srcBaseUrl) } : undefined,
  );

  const tgtBaseUrl = opts.targetApiUrl || "https://api.github.com";
  return {
    ...createTargetClients(opts.targetAuth, tgtBaseUrl),
    source: srcSide.client,
    sourceGraphql: srcSide.client.graphql as typeof graphql,
    getSourceToken: srcSide.getToken,
  };
}

/**
 * Create a standalone Octokit client for a single side — used when you only
 * need one side (e.g. rate limit checks) without constructing a full pair.
 */
export function createSingleClient(
  auth: AuthInput,
  baseUrl: string,
  request?: { fetch: GitHubFetch },
): InstanceType<typeof RetryOctokit> {
  return buildSide(auth, normalizeGitHubApiUrl(baseUrl), makeThrottleOptions(), request).client;
}

/** Bind the deadline to the whole Octokit operation, including auth, throttling and body reads. */
export function createProfileClient(
  auth: AuthInput,
  baseUrl: string,
  runSignal: AbortSignal,
  options: {
    deadline?: () => AbortSignal;
    fetch?: GitHubFetch;
    wait?: typeof sleep;
  } = {},
): GitHubClient & { drainProfileRequests(): Promise<void> } {
  const active = new AsyncLocalStorage<AbortSignal>();
  const pending = new Set<Promise<unknown>>();
  const transport = options.fetch ?? globalThis.fetch;
  const client = buildSide(
    auth,
    normalizeGitHubApiUrl(baseUrl),
    {
      // Keep the plugin's concurrency limits, but own retry timers so shutdown can cancel them.
      onRateLimit: () => false,
      onSecondaryRateLimit: () => false,
    },
    {
      fetch: async (url, init) => {
        runSignal.throwIfAborted();
        const signal = init?.signal ?? active.getStore() ?? runSignal;
        signal.throwIfAborted();
        return transport(url, { ...init, signal });
      },
    },
    false,
  ).client;

  client.hook.wrap("request", async (request, params) => {
    const signal = AbortSignal.any([
      runSignal,
      options.deadline?.() ?? AbortSignal.timeout(30_000),
    ]);
    signal.throwIfAborted();
    let onAbort!: () => void;
    const interrupted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    const perform = async () => {
      for (let attempt = 1; ; attempt++) {
        signal.throwIfAborted();
        try {
          const response = await request({ ...params, request: { ...params.request, signal } });
          signal.throwIfAborted();
          return response;
        } catch (error) {
          signal.throwIfAborted();
          const delay = profileRetryDelay(error, attempt);
          if (delay === null) throw error;
          await (options.wait ?? sleep)(Math.min(delay, 2_147_483_647), signal);
        }
      }
    };
    // The caller can time out before the underlying request or response body settles.
    const operation = active.run(signal, perform);
    pending.add(operation);
    const remove = () => pending.delete(operation);
    void operation.then(remove, remove);
    try {
      return await Promise.race([interrupted, operation]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  });
  return Object.assign(client, {
    async drainProfileRequests() {
      while (pending.size > 0) await Promise.allSettled(pending);
    },
  });
}

function profileRetryDelay(error: unknown, attempt: number): number | null {
  if (!(error instanceof Error) || attempt > 3) return null;
  const { status, response } = error as Error & {
    status?: number;
    response?: { headers?: Record<string, string> };
  };
  const headers = response?.headers;
  const reset = Number(headers?.["x-ratelimit-reset"]);
  if (headers?.["x-ratelimit-remaining"] === "0" || error.message === "GraphQL Rate Limit Exceeded")
    return reset > 0 ? Math.max(0, reset * 1000 - Date.now() + 1000) : 60_000;
  if (status === 429 || (status === 403 && /secondary rate/i.test(error.message)))
    return (Number(headers?.["retry-after"]) || 60) * 1000;
  return status !== undefined && status >= 500 ? attempt ** 2 * 1000 : null;
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
 * When GitHub advertises both the next and last pages, requesting one item per page
 * (`per_page=1`) makes that last-page number equal the total item count — so one
 * request sizes the collection without walking every page or materializing every
 * object. This is the standard, protocol-level way to count commits, webhooks,
 * and the like, rather than fetching them or walking a graph (e.g. GraphQL
 * `history.totalCount`, which walks the whole commit graph and times out at
 * scale).
 *
 * A first page with no pagination links can show an exact count of 0 or 1.
 * Incomplete or contradictory pagination cannot establish an exact count.
 *
 * @param client REST client.
 * @param route  Octokit route, e.g. `"GET /repos/{owner}/{repo}/commits"`.
 * @param params Route + query params; `page` and `per_page` are forced to 1.
 * @returns The item count.
 */
export async function countByPagination(
  client: InstanceType<typeof RetryOctokit>,
  route: string,
  params: Record<string, string | number>,
): Promise<number> {
  const res = await client.request(route, { ...params, page: 1, per_page: 1 });
  if (!Array.isArray(res.data) || res.data.length > 1)
    throw new Error(`Invalid count response for ${route}`);

  const count = countFromPageLinks(res.data.length, res.headers?.link ?? "", res.url);
  if (count !== null) return count;
  throw new Error(`Cannot determine count from pagination for ${route}`);
}

function countFromPageLinks(items: number, header: string, baseUrl: string): number | null {
  // Consume complete link values so commas inside targets and quoted parameters stay intact.
  const link =
    /\s*<([^<>]+)>((?:\s*;\s*[\w-]+(?:\s*=\s*(?:"(?:[^"\\]|\\.)*"|[^\s;,"]+))?)*)\s*(,|$)/gy;
  const next: string[] = [];
  const last: string[] = [];
  let hasFirst = false;
  while (link.lastIndex < header.length) {
    const entry = link.exec(header);
    if (!entry || (entry[3] === "," && link.lastIndex === header.length)) return null;
    const [, target, parameters] = entry;
    if (!target || parameters === undefined) return null;
    for (const parameter of parameters.matchAll(
      /;\s*([\w-]+)(?:\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s;,"]+)))?/g,
    )) {
      if (parameter[1]?.toLowerCase() !== "rel") continue;
      const relations = (parameter[2] ?? parameter[3] ?? "").trim().toLowerCase().split(/\s+/);
      if (relations.includes("prev") || relations.includes("previous")) return null;
      if (relations.includes("first")) hasFirst = true;
      if (relations.includes("next")) next.push(target);
      if (relations.includes("last")) last.push(target);
    }
  }
  if (!hasFirst && !next.length && !last.length) return items;
  if (items !== 1 || next.length !== 1 || last.length !== 1) return null;

  const nextPage = paginationLinkPage(next[0]!, baseUrl);
  const lastPage = paginationLinkPage(last[0]!, baseUrl);
  if (
    nextPage?.page !== 2 ||
    !lastPage ||
    lastPage.page < nextPage.page ||
    nextPage.collection !== lastPage.collection
  ) {
    return null;
  }
  return lastPage.page;
}

function paginationLinkPage(target: string, baseUrl: string) {
  const parsed = URL.parse(target, baseUrl || "https://github.invalid");
  if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) return null;
  const pages = parsed.searchParams.getAll("page");
  const sizes = parsed.searchParams.getAll("per_page");
  if (pages.length !== 1 || sizes.length > 1 || (sizes.length === 1 && sizes[0] !== "1"))
    return null;
  const value = pages[0] ?? "";
  const page = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(page)) return null;

  parsed.searchParams.delete("page");
  parsed.searchParams.delete("per_page");
  parsed.searchParams.sort();
  parsed.hash = "";
  return { page, collection: parsed.href };
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
