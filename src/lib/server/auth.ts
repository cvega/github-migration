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
import { env } from "$env/dynamic/private";
import type { AppAuth, AuthInput } from "$lib/types";
import { createSingleClient, getRateLimit, type RateLimitInfo } from "./github";

export type DisplayAuthMode = "pat" | "github-app";

export interface SideAuthConfig {
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
  if (!raw.startsWith("-----")) {
    try {
      return Buffer.from(raw, "base64").toString("utf-8");
    } catch {
      return raw;
    }
  }
  return raw;
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
  const raw = env.GH_ALLOW_CREDENTIAL_OVERRIDE;
  if (raw == null || raw === "") return true;
  const v = raw.trim().toLowerCase();
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

/** Split a comma/space/newline separated env list into a de-duplicated array. */
function parseOrgList(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[\s,]+/)) {
    const v = part.trim();
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/** Read the env-provided form defaults (source URL + pre-configured orgs). */
export function getFormDefaults(): FormDefaults {
  return {
    sourceApiUrl: env.GH_SOURCE_API_URL?.trim() || "",
    sourceOrgs: parseOrgList(env.GH_SOURCE_ORG),
    targetOrgs: parseOrgList(env.GH_TARGET_ORG),
  };
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
 * Resolve target auth input.
 * Priority: request PAT → request App → env App → env PAT → error.
 */
export function resolveTargetAuth(requestToken?: string, requestApp?: AppAuth): AuthInput {
  return resolveAuth(requestToken, requestApp, getTargetAppConfig, env.GH_TARGET_PAT, "target");
}

/**
 * Fetch live rate limits for both sides using env-configured credentials.
 * Returns partial results — if a side has no env credentials, its rate limit is null.
 * Uses the GET /rate_limit endpoint which does NOT count against quota.
 * Results are cached for 30 seconds to avoid redundant API calls on rapid navigation.
 */

let _rateLimitCache: {
  data: { source: RateLimitInfo | null; target: RateLimitInfo | null };
  expiresAt: number;
} | null = null;
const RATE_LIMIT_CACHE_TTL_MS = 30_000;

export async function fetchLiveRateLimits(): Promise<{
  source: RateLimitInfo | null;
  target: RateLimitInfo | null;
}> {
  // Return cached result if fresh.
  if (_rateLimitCache && Date.now() < _rateLimitCache.expiresAt) {
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
        getRateLimit(createSingleClient(sourceAuth, sourceBaseUrl))
          .then((r) => {
            results.source = r;
          })
          .catch(() => {}),
      );
    }
    if (targetAuth) {
      fetches.push(
        getRateLimit(createSingleClient(targetAuth, "https://api.github.com"))
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
    expiresAt: Date.now() + RATE_LIMIT_CACHE_TTL_MS,
  };

  return results;
}
