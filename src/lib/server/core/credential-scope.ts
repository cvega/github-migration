import type { SourceProvider } from "$lib/source/types";
import { getSourceProjectIdentity, isSourceProvider } from "$lib/source-provider";
import { getFormDefaults } from "./auth";
import { getMigrationTargetProfile } from "./targets";

export interface SourceUrlInput {
  sourceProvider?: unknown;
  sourceToken?: unknown;
  sourceApp?: unknown;
  sourceApiUrl?: unknown;
}

export interface CredentialScopeInput extends SourceUrlInput {
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

export function getInputSourceProvider(input: SourceUrlInput): SourceProvider {
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
  const provider = getInputSourceProvider(input);
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
  const provider = getInputSourceProvider(input);
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
