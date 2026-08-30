import { json } from "@sveltejs/kit";
import { getFormDefaults, isCredentialOverrideAllowed } from "$lib/server/core/auth";
import {
  type CredentialScopeInput,
  getInputSourceProvider,
  validateCredentialScope,
} from "$lib/server/core/credential-scope";
import { normalizeGitHubApiUrl } from "$lib/server/core/github";
import { getMigrationTargetProfile } from "$lib/server/core/targets";
import { resolveEffectiveSourceApiUrl } from "$lib/server/migrate/ports/source-runtime";
import { getBitbucketServerSourceConfig } from "$lib/server/source/bitbucket/config";
import { getGitLabSourceConfig } from "$lib/server/source/gitlab/config";
import { getMigrationCapability } from "./capabilities";
import { parseJsonBody } from "./request-body";

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

export function validateAuthAvailable(creds: CredentialScopeInput): string | null {
  const provider = getInputSourceProvider(creds);
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
