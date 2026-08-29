/**
 * Authoritative registry for provider capabilities, identity syntax, inventory
 * limits, profile capacity lanes, and migration executor selection. UI and
 * server code consume the same adapters so unsupported options are not inferred
 * from URLs or duplicated provider-name checks. Credentials remain owned by
 * the provider-specific server modules, not this registry.
 */

import { SOURCE_PROVIDERS, type SourceProvider } from "$lib/source/types";
import type { TargetPlatform } from "$lib/target-platform";

export { SOURCE_PROVIDERS, type SourceProvider } from "$lib/source/types";

type SourcePlatformIcon = "mark-github" | "gitlab-logo" | "bitbucket-logo";
export type MigrationExecutor =
  | "github-api"
  | "gitlab-native"
  | "gitlab-ghes"
  | "bitbucket-server-ghes"
  | "bitbucket-server-native";

interface SourceProviderCapabilities {
  inventory: boolean;
  planning: boolean;
  migrationExecution: boolean;
  restart: boolean;
  export: boolean;
  requestSourceCredentials: boolean;
  migrationMode: boolean;
  skipReleases: boolean;
  directPassthrough: boolean;
  sourceTlsBypass: boolean;
}

export interface SourceProviderAdapter {
  provider: SourceProvider;
  displayName: string;
  namespaceLabel: string;
  profileKind: "github-readiness" | "source-inventory";
  profileCapacityKey: string | null;
  inventoryProjectLimit: number | null;
  migrationExecutor: MigrationExecutor | null;
  capabilities: SourceProviderCapabilities;
  sourcePlatform(apiUrl: string | null | undefined): {
    label: string;
    displayName: string;
    icon: SourcePlatformIcon;
  };
  isValidNamespace(namespace: string): boolean;
  isValidProjectPath(path: string): boolean;
  isProjectInNamespace(path: string, namespace: string): boolean;
  projectName(path: string): string;
}

function pathSegments(path: string, minimum = 2): string[] | null {
  if (path.length > 2_048) return null;
  const segments = path.split("/");
  if (
    segments.length < minimum ||
    segments.some(
      (segment) =>
        !segment ||
        segment.length > 255 ||
        segment === "." ||
        segment === ".." ||
        /[\s\p{Cc}]/u.test(segment),
    )
  ) {
    return null;
  }
  return segments;
}

const GITHUB_ORG_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const BITBUCKET_PROJECT_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/;

function githubSourcePlatform(apiUrl: string | null | undefined): {
  label: string;
  displayName: string;
  icon: "mark-github";
} {
  const cloud = getGitHubSourcePlatform(apiUrl) === "ghec";
  return cloud
    ? { label: "GHEC", displayName: "GitHub Enterprise Cloud", icon: "mark-github" }
    : { label: "GHES", displayName: "GitHub Enterprise Server", icon: "mark-github" };
}

export function getGitHubSourcePlatform(apiUrl: string | null | undefined): TargetPlatform {
  const hostname = (() => {
    try {
      return new URL(apiUrl ?? "").hostname.toLowerCase();
    } catch {
      return "";
    }
  })();
  const cloud =
    hostname === "api.github.com" || hostname === "github.com" || hostname.endsWith(".ghe.com");
  return cloud ? "ghec" : "ghes";
}

export function sourceBaseUrl(apiUrl: string): string {
  const normalized = apiUrl.replace(/\/+$/, "").replace(/\/api\/v3$/, "");
  return normalized.replace("://api.", "://");
}

function apiWebBaseUrl(apiUrl: string, apiPath: string): string {
  const url = new URL(apiUrl);
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith(apiPath) ? path.slice(0, -apiPath.length) : path;
  return url.toString().replace(/\/$/, "");
}

function encodeProjectPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function sourceProjectUrl(
  provider: SourceProvider,
  apiUrl: string,
  namespace: string,
  repository: string,
): string {
  if (provider === "github") {
    return `${sourceBaseUrl(apiUrl)}/${encodeProjectPath(namespace)}/${encodeURIComponent(repository)}`;
  }
  if (provider === "gitlab") {
    return `${apiWebBaseUrl(apiUrl, "/api/v4")}/${encodeProjectPath(namespace)}/${encodeURIComponent(repository)}`;
  }
  return `${apiWebBaseUrl(apiUrl, "/rest/api/1.0")}/projects/${encodeURIComponent(namespace)}/repos/${encodeURIComponent(repository)}`;
}

function bitbucketProjectPath(path: string): [string, string] | null {
  const segments = pathSegments(path);
  if (segments?.length !== 2 || !BITBUCKET_PROJECT_KEY_RE.test(segments[0]!)) {
    return null;
  }
  return segments as [string, string];
}

const SOURCE_PROVIDER_ADAPTERS: Record<SourceProvider, SourceProviderAdapter> = {
  github: {
    provider: "github",
    displayName: "GitHub",
    namespaceLabel: "organization login",
    profileKind: "github-readiness",
    profileCapacityKey: "github",
    inventoryProjectLimit: 10_000,
    migrationExecutor: "github-api",
    capabilities: {
      inventory: true,
      planning: true,
      migrationExecution: true,
      restart: true,
      export: true,
      requestSourceCredentials: true,
      migrationMode: true,
      skipReleases: true,
      directPassthrough: true,
      sourceTlsBypass: true,
    },
    sourcePlatform: githubSourcePlatform,
    isValidNamespace: (namespace) => GITHUB_ORG_RE.test(namespace),
    isValidProjectPath: (path) => pathSegments(path)?.length === 2,
    isProjectInNamespace: (path, namespace) => {
      const owner = pathSegments(path)?.[0];
      return owner ? owner.toLowerCase() === namespace.toLowerCase() : false;
    },
    projectName: (path) => pathSegments(path)?.[1] ?? "",
  },
  gitlab: {
    provider: "gitlab",
    displayName: "GitLab",
    namespaceLabel: "namespace path",
    profileKind: "source-inventory",
    profileCapacityKey: "gitlab",
    inventoryProjectLimit: 10_000,
    migrationExecutor: "gitlab-native",
    capabilities: {
      inventory: true,
      planning: true,
      migrationExecution: true,
      restart: true,
      export: true,
      requestSourceCredentials: false,
      migrationMode: false,
      skipReleases: false,
      directPassthrough: false,
      sourceTlsBypass: false,
    },
    sourcePlatform: () => ({
      label: "GitLab",
      displayName: "GitLab",
      icon: "gitlab-logo",
    }),
    isValidNamespace: (namespace) => pathSegments(namespace, 1) !== null,
    isValidProjectPath: (path) => pathSegments(path) !== null,
    isProjectInNamespace: (path, namespace) => path.startsWith(`${namespace}/`),
    projectName: (path) => pathSegments(path)?.at(-1) ?? "",
  },
  "bitbucket-server": {
    provider: "bitbucket-server",
    displayName: "Bitbucket Server",
    namespaceLabel: "project key",
    profileKind: "source-inventory",
    profileCapacityKey: "bitbucket-server",
    inventoryProjectLimit: 10_000,
    migrationExecutor: "bitbucket-server-native",
    capabilities: {
      inventory: true,
      planning: true,
      migrationExecution: true,
      restart: true,
      export: true,
      requestSourceCredentials: false,
      migrationMode: false,
      skipReleases: true,
      directPassthrough: false,
      sourceTlsBypass: false,
    },
    sourcePlatform: () => ({
      label: "Bitbucket Server",
      displayName: "Bitbucket Server",
      icon: "bitbucket-logo",
    }),
    isValidNamespace: (namespace) => BITBUCKET_PROJECT_KEY_RE.test(namespace),
    isValidProjectPath: (path) => bitbucketProjectPath(path) !== null,
    isProjectInNamespace: (path, namespace) => {
      const segments = bitbucketProjectPath(path);
      return segments ? segments[0].toLowerCase() === namespace.toLowerCase() : false;
    },
    projectName: (path) => bitbucketProjectPath(path)?.[1] ?? "",
  },
};

export function isSourceProvider(value: unknown): value is SourceProvider {
  return SOURCE_PROVIDERS.includes(value as SourceProvider);
}

export function getSourceProviderAdapter(provider: SourceProvider): SourceProviderAdapter {
  return SOURCE_PROVIDER_ADAPTERS[provider];
}

export function getMigrationExecutor(
  provider: SourceProvider,
  targetPlatform: TargetPlatform = "ghec",
): MigrationExecutor | null {
  if (targetPlatform === "ghes") {
    if (provider === "gitlab") return "gitlab-ghes";
    if (provider === "bitbucket-server") return "bitbucket-server-ghes";
    return null;
  }
  const adapter = getSourceProviderAdapter(provider);
  return adapter.capabilities.migrationExecution ? adapter.migrationExecutor : null;
}

export function getSourceProjectIdentity(
  provider: SourceProvider,
  path: string,
): { namespace: string; name: string } {
  const adapter = getSourceProviderAdapter(provider);
  if (!adapter.isValidProjectPath(path)) {
    throw new TypeError(`${adapter.displayName} source repository path is invalid`);
  }
  const name = adapter.projectName(path);
  return {
    namespace: path.slice(0, -(name.length + 1)),
    name,
  };
}
