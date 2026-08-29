import type { SourceProvider } from "../../src/lib/source-provider";
import type { TargetPlatform } from "../../src/lib/target-platform";

export interface MigrationSeedRoute {
  id: string;
  sourceProvider: SourceProvider;
  sourceApiUrl: string;
  sourceOrg: string;
  targetProfileId: string;
  targetPlatform: TargetPlatform;
  targetApiUrl: string;
  targetOrg: string;
  repo: string;
}

export const LARGE_REPOSITORY_SIZE_KB = 8 * 1024 * 1024;

export const MIGRATION_SEED_ROUTES = [
  {
    id: "seed-feat-large-ghec-ghec",
    sourceProvider: "github",
    sourceApiUrl: "https://api.github.com",
    sourceOrg: "acme-cloud",
    targetProfileId: "ghec",
    targetPlatform: "ghec",
    targetApiUrl: "https://api.github.com",
    targetOrg: "acme-modernized",
    repo: "large-ghec-repository",
  },
  {
    id: "seed-feat-large-ghes-ghec",
    sourceProvider: "github",
    sourceApiUrl: "https://ghes.acme.corp/api/v3",
    sourceOrg: "acme-corp",
    targetProfileId: "ghec",
    targetPlatform: "ghec",
    targetApiUrl: "https://api.github.com",
    targetOrg: "acme-cloud",
    repo: "large-ghes-repository",
  },
  {
    id: "seed-feat-large-gitlab-ghec",
    sourceProvider: "gitlab",
    sourceApiUrl: "https://gitlab.foxtrot-labs.dev/api/v4",
    sourceOrg: "foxtrot-platform",
    targetProfileId: "ghec",
    targetPlatform: "ghec",
    targetApiUrl: "https://api.github.com",
    targetOrg: "foxtrot-cloud",
    repo: "large-gitlab-cloud-repository",
  },
  {
    id: "seed-feat-large-gitlab-ghes",
    sourceProvider: "gitlab",
    sourceApiUrl: "https://gitlab.nova-systems.net/api/v4",
    sourceOrg: "nova-platform",
    targetProfileId: "ghes-seed",
    targetPlatform: "ghes",
    targetApiUrl: "https://github.nova-systems.net/api/v3",
    targetOrg: "nova-engineering",
    repo: "large-gitlab-server-repository",
  },
  {
    id: "seed-feat-large-bitbucket-ghec",
    sourceProvider: "bitbucket-server",
    sourceApiUrl: "https://bitbucket.pinnacle-tech.dev/rest/api/1.0",
    sourceOrg: "PLATFORM",
    targetProfileId: "ghec",
    targetPlatform: "ghec",
    targetApiUrl: "https://api.github.com",
    targetOrg: "pinnacle-cloud",
    repo: "large-bitbucket-cloud-repository",
  },
  {
    id: "seed-feat-large-bitbucket-ghes",
    sourceProvider: "bitbucket-server",
    sourceApiUrl: "https://bitbucket.ironclad-sec.dev/rest/api/1.0",
    sourceOrg: "SECURITY",
    targetProfileId: "ghes-seed",
    targetPlatform: "ghes",
    targetApiUrl: "https://github.ironclad-sec.dev/api/v3",
    targetOrg: "security-platform",
    repo: "large-bitbucket-server-repository",
  },
] as const satisfies readonly MigrationSeedRoute[];

export function migrationSeedRoute(index: number): (typeof MIGRATION_SEED_ROUTES)[number] {
  const route = MIGRATION_SEED_ROUTES[index % MIGRATION_SEED_ROUTES.length];
  if (!route) throw new Error("Migration seed routes must not be empty");
  return route;
}
