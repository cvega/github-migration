/**
 * Request-body helpers shared by the API endpoints: JSON parsing and
 * env-dependent auth-availability checks. Request *shape* validation lives
 * in schemas.ts (Zod).
 *
 * Server-owned credentials are restricted to their configured GitHub orgs,
 * GitLab namespaces (including descendants), Bitbucket project keys, and target
 * GitHub orgs. One-off GitHub source credentials bypass namespace defaults when
 * overrides are enabled, but their source API URL must be in the administrator
 * allowlist. Invalid allowlist entries are ignored rather than widening access.
 */

import { json } from "@sveltejs/kit";
import { getMigrationTargetProfile } from "$lib/server/core/targets";
import { normalizeBitbucketServerApiUrl } from "$lib/server/source/bitbucket/client";
import { getBitbucketServerSourceConfig } from "$lib/server/source/bitbucket/config";
import { normalizeGitLabApiUrl } from "$lib/server/source/gitlab/client";
import { getGitLabSourceConfig } from "$lib/server/source/gitlab/config";
import type { SourceProvider } from "$lib/source/types";
import { getSourceProjectIdentity, isSourceProvider } from "$lib/source-provider";
import { getMigrationCapability } from "./capability-report";
import { getFormDefaults, isCredentialOverrideAllowed } from "./core/auth";
import { normalizeGitHubApiUrl } from "./core/github";

interface SourceUrlInput {
  sourceProvider?: unknown;
  sourceToken?: unknown;
  sourceApp?: unknown;
  sourceApiUrl?: unknown;
}

interface CredentialScopeInput extends SourceUrlInput {
  targetProfileId?: unknown;
  targetToken?: unknown;
  targetApp?: unknown;
  sourceRepo?: unknown;
  repos?: unknown;
  items?: unknown;
  targetOrg?: unknown;
  noSslVerify?: unknown;
  lockSource?: unknown;
  archiveSource?: unknown;
  directPassthrough?: unknown;
  gitArchivePath?: unknown;
  metadataArchivePath?: unknown;
}

function sourceProvider(input: SourceUrlInput): SourceProvider {
  return isSourceProvider(input.sourceProvider) ? input.sourceProvider : "github";
}

function sourceOrganizations(input: CredentialScopeInput): string[] {
  const repositories: string[] = [];
  if (typeof input.sourceRepo === "string") repositories.push(input.sourceRepo);
  if (Array.isArray(input.repos)) {
    repositories.push(...input.repos.filter((repo): repo is string => typeof repo === "string"));
  }
  if (Array.isArray(input.items)) {
    for (const item of input.items) {
      if (item && typeof item === "object" && typeof item.sourceRepo === "string") {
        repositories.push(item.sourceRepo);
      }
    }
  }
  const provider = sourceProvider(input);
  return repositories
    .map((repo) => {
      try {
        return getSourceProjectIdentity(provider, repo).namespace;
      } catch {
        return "";
      }
    })
    .filter(Boolean);
}

function parseConfiguredScopes(raw: string | undefined): string[] {
  return raw?.match(/[^\s,]+/g) ?? [];
}

export function validateCredentialScope(input: CredentialScopeInput): string | null {
  const provider = sourceProvider(input);
  const defaults = getFormDefaults();
  const targetOrg = typeof input.targetOrg === "string" ? input.targetOrg : null;
  const targetProfileId =
    typeof input.targetProfileId === "string" ? input.targetProfileId : undefined;
  const configuredTargetOrgs =
    getMigrationTargetProfile(targetProfileId)?.organizations ?? defaults.targetOrgs;
  const configuredSourceNamespaces =
    provider === "bitbucket-server"
      ? parseConfiguredScopes(process.env.BITBUCKET_SERVER_PROJECT_KEYS)
      : provider === "gitlab"
        ? parseConfiguredScopes(process.env.GITLAB_SOURCE_NAMESPACE)
        : defaults.sourceOrgs;
  if (!input.sourceToken && !input.sourceApp && configuredSourceNamespaces.length > 0) {
    const allowed = configuredSourceNamespaces.map((org) => org.toLowerCase());
    const denied = sourceOrganizations(input).find((org) => {
      const normalized = org.toLowerCase();
      return !allowed.some((scope) =>
        provider === "gitlab"
          ? normalized === scope || normalized.startsWith(`${scope}/`)
          : normalized === scope,
      );
    });
    if (denied) {
      return `${provider === "bitbucket-server" ? "Bitbucket project key" : provider === "gitlab" ? "GitLab namespace" : "Source organization"} '${denied}' is not configured for server credentials`;
    }
  }
  if (
    !input.targetToken &&
    !input.targetApp &&
    configuredTargetOrgs.length > 0 &&
    targetOrg !== null &&
    !configuredTargetOrgs.some((org) => org.toLowerCase() === targetOrg.toLowerCase())
  ) {
    return `Target organization '${targetOrg}' is not configured for server credentials`;
  }
  return null;
}

export function validateProfileCredentialScope(
  sourceProvider: SourceProvider,
  namespace: string,
): string | null {
  const configured = (() => {
    if (sourceProvider === "github") return getFormDefaults().sourceOrgs;
    const variable =
      sourceProvider === "gitlab"
        ? process.env.GITLAB_SOURCE_NAMESPACE
        : process.env.BITBUCKET_SERVER_PROJECT_KEYS;
    return parseConfiguredScopes(variable);
  })();
  if (configured.length === 0) return null;
  const normalized = namespace.toLowerCase();
  const allowed = configured.some((candidate) => {
    const scope = candidate.toLowerCase();
    return sourceProvider === "gitlab"
      ? normalized === scope || normalized.startsWith(`${scope}/`)
      : normalized === scope;
  });
  return allowed
    ? null
    : `${sourceProvider === "gitlab" ? "Namespace" : sourceProvider === "bitbucket-server" ? "Project key" : "Source organization"} '${namespace}' is not configured for server credentials`;
}

export function resolveEffectiveSourceApiUrl(creds: SourceUrlInput): string {
  if (sourceProvider(creds) === "gitlab") {
    const configured = getGitLabSourceConfig().apiUrl;
    const requested = typeof creds.sourceApiUrl === "string" ? creds.sourceApiUrl.trim() : "";
    return normalizeGitLabApiUrl(requested || configured);
  }
  if (sourceProvider(creds) === "bitbucket-server") {
    const configured = getBitbucketServerSourceConfig().apiUrl;
    const requested = typeof creds.sourceApiUrl === "string" ? creds.sourceApiUrl.trim() : "";
    return normalizeBitbucketServerApiUrl(requested || configured, {
      allowInsecureHttp: process.env.BITBUCKET_SERVER_ALLOW_INSECURE_HTTP === "true",
    });
  }
  const requestUrl = typeof creds.sourceApiUrl === "string" ? creds.sourceApiUrl : "";
  const serverUrl = !creds.sourceToken && !creds.sourceApp ? getFormDefaults().sourceApiUrl : "";
  return normalizeGitHubApiUrl(requestUrl || serverUrl || "https://api.github.com");
}

export function validatePersistedServerCredentialScope(input: CredentialScopeInput): string | null {
  const scopeError = validateCredentialScope(input);
  if (scopeError) return scopeError;
  try {
    if (
      resolveEffectiveSourceApiUrl(input) !==
      resolveEffectiveSourceApiUrl({ sourceProvider: sourceProvider(input) })
    ) {
      return "Persisted source API URL no longer matches the server-configured source";
    }
  } catch {
    return "Persisted source API URL is invalid";
  }
  return null;
}

function allowedRequestSourceApiUrls(): Set<string> {
  const configured = getFormDefaults().sourceApiUrl;
  const candidates = [
    "https://api.github.com",
    configured,
    ...(process.env.GH_ALLOWED_SOURCE_API_URLS ?? "").split(","),
  ];
  const allowed = new Set<string>();
  for (const candidate of candidates) {
    try {
      allowed.add(normalizeGitHubApiUrl(candidate));
    } catch {
      // Invalid administrator entries do not widen outbound access.
    }
  }
  return allowed;
}

/**
 * Safely parse a JSON request body. Returns the parsed object or an error string.
 */
export async function parseJsonBody(
  request: Request,
): Promise<{ data: Record<string, unknown> } | { error: string; status: 400 | 415 }> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return { error: "Content-Type must be application/json", status: 415 };
  }
  try {
    const data = await request.json();
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return { error: "Request body must be a JSON object", status: 400 };
    }
    return { data: data as Record<string, unknown> };
  } catch {
    return { error: "Invalid JSON in request body", status: 400 };
  }
}

type AuthCredentials = CredentialScopeInput;

export async function parseAuthenticatedBody<T extends AuthCredentials>(
  request: Request,
  validate: (
    data: Record<string, unknown>,
  ) => { ok: true; value: T } | { ok: false; error: string },
): Promise<{ body: T } | { errorResponse: Response }> {
  const parsed = await parseJsonBody(request);
  if ("error" in parsed) {
    return { errorResponse: json({ error: parsed.error }, { status: parsed.status }) };
  }
  const result = validate(parsed.data);
  if (!result.ok) {
    return { errorResponse: json({ error: result.error }, { status: 400 }) };
  }
  const authError = validateAuthAvailable(result.value);
  if (authError) {
    return { errorResponse: json({ error: authError }, { status: 400 }) };
  }
  return { body: result.value };
}

/**
 * Verify that both sides have usable credentials: a per-request token/app, or
 * env-configured auth. Returns an error string for the first missing side, or
 * null when both are satisfied.
 */
export function validateAuthAvailable(creds: CredentialScopeInput): string | null {
  const provider = sourceProvider(creds);
  const targetProfileId =
    typeof creds.targetProfileId === "string" ? creds.targetProfileId : undefined;
  const targetProfile = getMigrationTargetProfile(targetProfileId);
  const targetsGhes = targetProfile?.platform === "ghes";
  if (
    !isCredentialOverrideAllowed() &&
    (creds.sourceToken || creds.sourceApp || creds.targetToken || creds.targetApp)
  ) {
    return "Credential override is disabled — use the server-configured credentials";
  }

  if (provider !== "github" && (creds.sourceToken || creds.sourceApp)) {
    return `${provider === "gitlab" ? "GitLab" : "Bitbucket"} source credentials must be configured on the server`;
  }

  if (
    provider !== "github" &&
    (creds.noSslVerify ||
      creds.lockSource ||
      creds.archiveSource ||
      creds.directPassthrough ||
      creds.gitArchivePath ||
      creds.metadataArchivePath)
  ) {
    return `${provider === "gitlab" ? "GitLab" : "Bitbucket"} migrations do not support GitHub source archive, lock, passthrough, or SSL override options`;
  }

  const gitlabConfig = provider === "gitlab" ? getGitLabSourceConfig() : null;
  const bitbucketConfig = provider === "bitbucket-server" ? getBitbucketServerSourceConfig() : null;
  if (targetsGhes && (creds.targetToken || creds.targetApp)) {
    return "GHES target credentials must be configured on the server";
  }
  let effectiveSourceApiUrl: string;
  try {
    effectiveSourceApiUrl = resolveEffectiveSourceApiUrl(creds);
  } catch {
    return "Source API URL is invalid";
  }
  const capability = getMigrationCapability(provider, targetProfile?.id ?? "ghec", {
    sourceAuthProvided: provider === "github" && Boolean(creds.sourceToken || creds.sourceApp),
    targetAuthProvided: !targetsGhes && Boolean(creds.targetToken || creds.targetApp),
  });
  if (capability.status !== "ready") {
    return capability.reasons[0]?.message ?? "Migration path is not available";
  }

  const scopeError = validateCredentialScope(creds);
  if (scopeError) return scopeError;

  if (provider === "github" && (creds.sourceToken || creds.sourceApp)) {
    if (!allowedRequestSourceApiUrls().has(effectiveSourceApiUrl)) {
      return "Source API URL is not in the administrator-approved source allowlist";
    }
  }

  if (provider === "github" && !creds.sourceToken && !creds.sourceApp) {
    const configuredUrl = getFormDefaults().sourceApiUrl || "https://api.github.com";
    if (effectiveSourceApiUrl !== normalizeGitHubApiUrl(configuredUrl)) {
      return "Source API URL must match the server-configured source when using server credentials";
    }
  }
  if (provider === "gitlab" && effectiveSourceApiUrl !== gitlabConfig?.apiUrl) {
    return "Source API URL must match the server-configured GitLab source";
  }
  if (provider === "bitbucket-server" && effectiveSourceApiUrl !== bitbucketConfig?.apiUrl) {
    return "Source API URL must match the server-configured Bitbucket source";
  }
  return null;
}
