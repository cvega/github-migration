/**
 * Authentication provider — supports both PAT and GitHub App auth for
 * source AND target independently.
 *
 * Source GitHub App env vars (GHES or GHEC source):
 *   GH_SOURCE_APP_ID              — GitHub App ID on the source instance
 *   GH_SOURCE_APP_PRIVATE_KEY     — PEM private key (literal or base64-encoded)
 *   GH_SOURCE_APP_INSTALLATION_ID — Installation ID for the source org
 *
 * Target GitHub App env vars (GHEC target):
 *   GH_TARGET_APP_ID              — GitHub App ID on GHEC
 *   GH_TARGET_APP_PRIVATE_KEY     — PEM private key (literal or base64-encoded)
 *   GH_TARGET_APP_INSTALLATION_ID — Installation ID for the target org
 *
 * When a GitHub App is configured for a side, the PEM is used to
 * auto-generate and auto-refresh installation tokens. Users don't
 * need to provide PATs for that side.
 *
 * PAT fields remain available as overrides — if a PAT is provided in the
 * request it takes precedence over the GitHub App token.
 */

import { env } from "node:process";
import type { graphql } from "@octokit/graphql";
import type { AppAuth, AuthInput } from "$lib/migrate/types";
import {
  createProfileClient,
  createSingleClient,
  type GitHubClient,
  getRateLimit,
  normalizeGitHubApiUrl,
  type RateLimitInfo,
} from "./github";

type DisplayAuthMode = "pat" | "github-app";

interface SideAuthConfig {
  mode: DisplayAuthMode;
  appId?: string;
  installationId?: string;
  /** Whether an env-level PAT is configured for this side. */
  hasEnvPat?: boolean;
  /** Static rate limit ceiling for this auth mode. */
  rateLimit: number;
  /** Live rate limit info – populated if credentials are available. */
  rateLimitLive?: RateLimitInfo;
}

export interface AuthConfig {
  source: SideAuthConfig;
  target: SideAuthConfig;
}

interface AppCredentials {
  appId: string;
  privateKey: string;
  installationId: string;
}

// ── Config detection ────────────────────────────────────────────────────────

function decodePrivateKey(raw: string): string {
  // Support base64-encoded PEM (common in env vars to avoid newline issues).
  const decoded = Buffer.from(raw, "base64").toString("utf-8");
  return decoded.startsWith("-----BEGIN ") ? decoded : raw;
}

function getSourceAppConfig(): AppCredentials | null {
  const appId = env.GH_SOURCE_APP_ID;
  const privateKeyRaw = env.GH_SOURCE_APP_PRIVATE_KEY;
  const installationId = env.GH_SOURCE_APP_INSTALLATION_ID;
  if (!appId || !privateKeyRaw || !installationId) return null;
  return { appId, privateKey: decodePrivateKey(privateKeyRaw), installationId };
}

function getTargetAppConfig(): AppCredentials | null {
  const appId = env.GH_TARGET_APP_ID;
  const privateKeyRaw = env.GH_TARGET_APP_PRIVATE_KEY;
  const installationId = env.GH_TARGET_APP_INSTALLATION_ID;
  if (!appId || !privateKeyRaw || !installationId) return null;
  return { appId, privateKey: decodePrivateKey(privateKeyRaw), installationId };
}

function sideConfig(app: AppCredentials | null, envPat?: string): SideAuthConfig {
  if (app) {
    return {
      mode: "github-app",
      appId: app.appId,
      installationId: app.installationId,
      hasEnvPat: !!envPat,
      rateLimit: 15_000,
    };
  }
  return { mode: "pat", hasEnvPat: !!envPat, rateLimit: 5_000 };
}

/** Returns auth configuration for both sides (no secrets exposed). */
export function getAuthConfig(): AuthConfig {
  return {
    source: sideConfig(getSourceAppConfig(), env.GH_SOURCE_PAT),
    target: sideConfig(getTargetAppConfig(), env.GH_TARGET_PAT),
  };
}

/** Whether a GitHub App is configured for the source. */
export function isSourceAppConfigured(): boolean {
  return getSourceAppConfig() !== null;
}

/** Whether a GitHub App is configured for the target. */
export function isTargetAppConfigured(): boolean {
  return getTargetAppConfig() !== null;
}

/** Whether any env-level auth (App or PAT) is available for the source. */
export function isSourceAuthAvailable(): boolean {
  return getSourceAppConfig() !== null || !!env.GH_SOURCE_PAT;
}

/** Whether any env-level auth (App or PAT) is available for the target. */
export function isTargetAuthAvailable(): boolean {
  return getTargetAppConfig() !== null || !!env.GH_TARGET_PAT;
}

/**
 * Whether the UI may let a user override the server's env-configured
 * credentials with their own PAT or GitHub App. Defaults to allowed; set
 * `GH_ALLOW_CREDENTIAL_OVERRIDE=false` (or `0`/`no`/`off`) to lock migrations
 * to the server's configured credentials. Only affects sides that actually
 * have env credentials — a side with none always requires user-supplied auth.
 */
export function isCredentialOverrideAllowed(): boolean {
  const v = env.GH_ALLOW_CREDENTIAL_OVERRIDE?.trim().toLowerCase();
  return v !== "false" && v !== "0" && v !== "no" && v !== "off";
}

/** Pre-configured defaults that pre-fill (and optionally lock) the new-migration form. */
export interface FormDefaults {
  /** Default source API URL (GH_SOURCE_API_URL), or "" when unset. */
  sourceApiUrl: string;
  /** Pre-configured source orgs (GH_SOURCE_ORG, comma/space separated). */
  sourceOrgs: string[];
  /** Pre-configured target orgs (GH_TARGET_ORG, comma/space separated). */
  targetOrgs: string[];
}

export interface GitHubSourceConfig {
  apiUrl: string;
  authAvailable: boolean;
}

/** Split a comma/space/newline separated env list into a de-duplicated array. */
function parseOrgList(raw: string | undefined): string[] {
  return [...new Set(raw?.match(/[^\s,]+/g) ?? [])];
}

function configuredSourceApiUrl(): string {
  return env.GH_SOURCE_API_URL?.trim() || "https://api.github.com";
}

/** Read the env-provided form defaults (source URL + pre-configured orgs). */
export function getFormDefaults(): FormDefaults {
  let sourceApiUrl = "";
  try {
    sourceApiUrl = normalizeGitHubApiUrl(env.GH_SOURCE_API_URL ?? "");
  } catch {
    // Invalid or absent configuration is not offered as a form default.
  }
  return {
    sourceApiUrl,
    sourceOrgs: parseOrgList(env.GH_SOURCE_ORG),
    targetOrgs: parseOrgList(env.GH_TARGET_ORG),
  };
}

export function getGitHubSourceConfig(): GitHubSourceConfig {
  try {
    return {
      apiUrl: normalizeGitHubApiUrl(configuredSourceApiUrl()),
      authAvailable: isSourceAuthAvailable(),
    };
  } catch {
    return { apiUrl: "", authAvailable: false };
  }
}

// ── Auth input resolution (for auto-refreshing Octokit clients) ─────────

/**
 * Resolve auth input for one side. Priority: request PAT → request App →
 * env App → env PAT → error. Returns credentials (not a resolved token) so
 * that `createClients` can set up auto-refreshing auth. Shared by the source
 * and target resolvers, which differ only in env source and error label.
 */
function resolveAuth(
  requestToken: string | undefined,
  requestApp: AppAuth | undefined,
  getEnvApp: () => AppCredentials | null,
  envPat: string | undefined,
  side: "source" | "target",
): AuthInput {
  if (requestToken) return { token: requestToken };
  if (requestApp) {
    return {
      appId: requestApp.appId,
      privateKey: decodePrivateKey(requestApp.privateKey),
      installationId: Number(requestApp.installationId),
    };
  }
  const envApp = getEnvApp();
  if (envApp) {
    return {
      appId: envApp.appId,
      privateKey: envApp.privateKey,
      installationId: Number(envApp.installationId),
    };
  }
  if (envPat) return { token: envPat };
  throw new Error(`No ${side} token provided and no ${side} GitHub App configured`);
}

/**
 * Resolve source auth input.
 * Priority: request PAT → request App → env App → env PAT → error.
 */
export function resolveSourceAuth(requestToken?: string, requestApp?: AppAuth): AuthInput {
  return resolveAuth(requestToken, requestApp, getSourceAppConfig, env.GH_SOURCE_PAT, "source");
}

/**
 * Build both a GraphQL and a REST client for the source instance from
 * env-configured credentials, plus the resolved source API URL. The Profiler
 * uses the GraphQL client to crawl repositories and the REST client for
 * endpoints GraphQL doesn't expose (e.g. rulesets). Throws when no source auth
 * is configured (callers map that to a 400).
 */
export function getSourceClients(signal?: AbortSignal): {
  gql: typeof graphql;
  rest: GitHubClient;
  sourceApiUrl: string;
  getApiCalls: () => number;
} {
  const sourceAuth = resolveSourceAuth();
  const sourceApiUrl = normalizeGitHubApiUrl(configuredSourceApiUrl());
  const client = signal
    ? createProfileClient(sourceAuth, sourceApiUrl, signal)
    : rateLimitDependencies.createSingleClient(sourceAuth, sourceApiUrl);
  // Count every HTTP request the crawl makes. The `before` hook fires once per
  // actual request — REST and GraphQL (both go through Octokit's request
  // pipeline), each pagination page, and each retry — so the tally reflects the
  // true API cost of a run, which the runner persists for rate-limit visibility.
  let apiCalls = 0;
  client.hook.before("request", () => {
    apiCalls += 1;
  });
  return {
    gql: client.graphql as typeof graphql,
    rest: client,
    sourceApiUrl,
    getApiCalls: () => apiCalls,
  };
}

/**
 * Resolve target auth input.
 * Priority: request PAT → request App → env App → env PAT → error.
 */
export function resolveTargetAuth(requestToken?: string, requestApp?: AppAuth): AuthInput {
  return resolveAuth(requestToken, requestApp, getTargetAppConfig, env.GH_TARGET_PAT, "target");
}

/**
 * Fetch live rate limits for both sides using env-configured credentials.
 * Returns partial results: a side is null when it has no env credentials or its
 * request fails. Successful and failed side results are cached together for 30
 * seconds; this is a display cache, not a last-known-good availability signal.
 * Uses the GET /rate_limit endpoint which does NOT count against quota.
 */

let _rateLimitCache: {
  data: { source: RateLimitInfo | null; target: RateLimitInfo | null };
  expiresAt: number;
} | null = null;
const RATE_LIMIT_CACHE_TTL_MS = 30_000;

const defaultRateLimitDependencies = {
  createSingleClient,
  getRateLimit,
  now: () => Date.now(),
};
let rateLimitDependencies = { ...defaultRateLimitDependencies };

/** Override rate-limit I/O and isolate cache state in tests. */
export function __setRateLimitDependenciesForTests(
  overrides: Partial<typeof defaultRateLimitDependencies>,
): () => void {
  const previousDependencies = rateLimitDependencies;
  const previousCache = _rateLimitCache;
  rateLimitDependencies = { ...defaultRateLimitDependencies, ...overrides };
  _rateLimitCache = null;
  return () => {
    rateLimitDependencies = previousDependencies;
    _rateLimitCache = previousCache;
  };
}

/** Return the last rate-limit result without performing network I/O. */
export function getCachedLiveRateLimits(): {
  source: RateLimitInfo | null;
  target: RateLimitInfo | null;
} {
  return _rateLimitCache?.data ?? { source: null, target: null };
}

export async function fetchLiveRateLimits(): Promise<{
  source: RateLimitInfo | null;
  target: RateLimitInfo | null;
}> {
  // Return cached result if fresh.
  if (_rateLimitCache && rateLimitDependencies.now() < _rateLimitCache.expiresAt) {
    return _rateLimitCache.data;
  }

  let sourceAuth: AuthInput | null = null;
  let targetAuth: AuthInput | null = null;

  // Try env-based auth for each side.
  try {
    sourceAuth = resolveSourceAuth();
  } catch {
    /* no env credentials */
  }
  try {
    targetAuth = resolveTargetAuth();
  } catch {
    /* no env credentials */
  }

  if (!sourceAuth && !targetAuth) return { source: null, target: null };

  const results: {
    source: RateLimitInfo | null;
    target: RateLimitInfo | null;
  } = {
    source: null,
    target: null,
  };

  try {
    const fetches: Promise<void>[] = [];
    if (sourceAuth) {
      const sourceBaseUrl = env.GH_SOURCE_API_URL || "https://api.github.com";
      fetches.push(
        rateLimitDependencies
          .getRateLimit(rateLimitDependencies.createSingleClient(sourceAuth, sourceBaseUrl))
          .then((r) => {
            results.source = r;
          })
          .catch(() => {}),
      );
    }
    if (targetAuth) {
      fetches.push(
        rateLimitDependencies
          .getRateLimit(
            rateLimitDependencies.createSingleClient(targetAuth, "https://api.github.com"),
          )
          .then((r) => {
            results.target = r;
          })
          .catch(() => {}),
      );
    }
    await Promise.all(fetches);
  } catch {
    // Non-fatal — return whatever we have
  }

  _rateLimitCache = {
    data: results,
    expiresAt: rateLimitDependencies.now() + RATE_LIMIT_CACHE_TTL_MS,
  };

  return results;
}
