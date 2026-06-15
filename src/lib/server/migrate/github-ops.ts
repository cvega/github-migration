/**
 * GitHub cross-product migration operations — the migration-specific GitHub
 * calls that drive the import pipeline, kept out of `core/github` so that
 * module stays a generic client + repo-operations primitive any domain can use.
 *
 * Two groups:
 *   - GHES archive export (REST): version gate + git/metadata archive jobs and
 *     the poll-until-exported wait.
 *   - Migration GraphQL: migration-source creation, start/get/abort a repository
 *     migration, and post-migration source archiving.
 *
 * Depends only on `core` (the client type, the version comparator, sleep) — no
 * dependency back from `core/github` into here, so the layering holds.
 */
import type { graphql } from "@octokit/graphql";
import { type GitHubClient, isVersionAtLeast } from "$lib/server/core/github";
import { sleep } from "$lib/server/core/util";

// ── GHES archive export (REST) ───────────────────────────────────────────────

/** Response shape for GHES /api/v3/meta. */
interface GhesMetaResponse {
  installed_version: string;
}

/** Response shape for GHES migration create/get. */
interface GhesMigrationResponse {
  id: number;
  state: string;
}

const MIN_GHES_VERSION = "3.15.0";

export async function checkGhesVersion(client: GitHubClient): Promise<string> {
  const { data } = await client.request("GET /api/v3/meta");
  const version = (data as GhesMetaResponse).installed_version;
  if (!version) throw new Error("Could not determine GHES version");
  if (!isVersionAtLeast(version, MIN_GHES_VERSION)) {
    throw new Error(`GHES version ${version} is below minimum required ${MIN_GHES_VERSION}`);
  }
  return version;
}

export async function startGitArchiveExport(
  client: GitHubClient,
  org: string,
  repo: string,
): Promise<number> {
  const { data } = await client.request("POST /api/v3/orgs/{org}/migrations", {
    org,
    repositories: [repo],
    exclude_metadata: true,
  });
  return (data as GhesMigrationResponse).id;
}

export async function startMetadataArchiveExport(
  client: GitHubClient,
  org: string,
  repo: string,
  skipReleases: boolean,
  lockSource: boolean,
): Promise<number> {
  const { data } = await client.request("POST /api/v3/orgs/{org}/migrations", {
    org,
    repositories: [repo],
    exclude_git_data: true,
    exclude_releases: skipReleases,
    lock_repositories: lockSource,
    exclude_owner_projects: true,
  });
  return (data as GhesMigrationResponse).id;
}

async function getArchiveStatus(
  client: GitHubClient,
  org: string,
  archiveId: number,
): Promise<string> {
  const { data } = await client.request("GET /api/v3/orgs/{org}/migrations/{migration_id}", {
    org,
    migration_id: archiveId,
  });
  return (data as GhesMigrationResponse).state;
}

async function getArchiveUrl(
  client: GitHubClient,
  org: string,
  archiveId: number,
): Promise<string> {
  const { data } = await client.request(
    "GET /api/v3/orgs/{org}/migrations/{migration_id}/archive",
    {
      org,
      migration_id: archiveId,
    },
  );
  return typeof data === "string" ? data.trim() : "";
}

export async function waitForArchive(
  client: GitHubClient,
  org: string,
  archiveId: number,
  signal?: AbortSignal,
  pollInterval = 60_000,
  maxWaitMs = 2 * 60 * 60 * 1000, // 2 hours default
): Promise<string> {
  const deadline = Date.now() + maxWaitMs;
  while (!signal?.aborted) {
    const status = await getArchiveStatus(client, org, archiveId);
    if (status === "exported") return getArchiveUrl(client, org, archiveId);
    if (status === "failed") throw new Error(`Archive export ${archiveId} failed`);
    if (Date.now() >= deadline) {
      throw new Error(
        `Archive export ${archiveId} timed out after ${Math.round(maxWaitMs / 60_000)} minutes`,
      );
    }
    await sleep(pollInterval, signal);
  }
  throw new Error("Archive wait aborted");
}

// ── Migration GraphQL ───────────────────────────────────────────────────────────

export async function getOrgId(gql: typeof graphql, org: string): Promise<string> {
  const result = await gql<{ organization: { id: string } }>(
    `query($login: String!) { organization(login: $login) { id } }`,
    { login: org },
  );
  return result.organization.id;
}

export async function getOrgDatabaseId(gql: typeof graphql, org: string): Promise<string> {
  const result = await gql<{ organization: { databaseId: number } }>(
    `query($login: String!) { organization(login: $login) { databaseId } }`,
    { login: org },
  );
  return String(result.organization.databaseId);
}

export async function createMigrationSource(gql: typeof graphql, orgId: string): Promise<string> {
  const result = await gql<{ createMigrationSource: { migrationSource: { id: string } } }>(
    `mutation($name: String!, $sourceUrl: String!, $ownerId: ID!, $type: MigrationSourceType!) {
			createMigrationSource(input: { name: $name, url: $sourceUrl, ownerId: $ownerId, type: $type }) {
				migrationSource { id }
			}
		}`,
    {
      name: "GHEC Source",
      sourceUrl: "https://github.com",
      ownerId: orgId,
      type: "GITHUB_ARCHIVE",
    },
  );
  return result.createMigrationSource.migrationSource.id;
}

export interface StartMigrationOpts {
  migrationSourceId: string;
  sourceRepoUrl: string;
  orgId: string;
  repoName: string;
  sourceToken: string;
  targetToken: string;
  gitArchiveUrl: string;
  metadataArchiveUrl: string;
  skipReleases?: boolean;
  targetRepoVisibility?: string;
  lockSource?: boolean;
}

export async function startMigration(
  gql: typeof graphql,
  opts: StartMigrationOpts,
): Promise<string> {
  const mutation = `mutation startRepositoryMigration(
		$sourceId: ID!, $ownerId: ID!, $sourceRepositoryUrl: URI!,
		$repositoryName: String!, $continueOnError: Boolean!,
		$gitArchiveUrl: String, $metadataArchiveUrl: String,
		$accessToken: String!, $githubPat: String, $skipReleases: Boolean,
		$targetRepoVisibility: String, $lockSource: Boolean
	) {
		startRepositoryMigration(input: {
			sourceId: $sourceId, ownerId: $ownerId,
			sourceRepositoryUrl: $sourceRepositoryUrl,
			repositoryName: $repositoryName, continueOnError: $continueOnError,
			gitArchiveUrl: $gitArchiveUrl, metadataArchiveUrl: $metadataArchiveUrl,
			accessToken: $accessToken, githubPat: $githubPat,
			skipReleases: $skipReleases, targetRepoVisibility: $targetRepoVisibility, lockSource: $lockSource
		}) {
			repositoryMigration { id }
		}
	}`;

  const variables: Record<string, unknown> = {
    sourceId: opts.migrationSourceId,
    ownerId: opts.orgId,
    sourceRepositoryUrl: opts.sourceRepoUrl,
    repositoryName: opts.repoName,
    continueOnError: true,
    gitArchiveUrl: opts.gitArchiveUrl || null,
    metadataArchiveUrl: opts.metadataArchiveUrl || null,
    accessToken: opts.sourceToken,
    githubPat: opts.targetToken,
    skipReleases: opts.skipReleases ?? false,
    targetRepoVisibility: opts.targetRepoVisibility || null,
    lockSource: opts.lockSource ?? false,
  };

  const result = await gql<{
    startRepositoryMigration: { repositoryMigration: { id: string } };
  }>(mutation, variables);
  return result.startRepositoryMigration.repositoryMigration.id;
}

export interface GhecMigration {
  state: string;
  repositoryName: string;
  warningsCount: number;
  failureReason: string;
  migrationLogUrl: string;
}

export async function getMigration(
  gql: typeof graphql,
  migrationId: string,
): Promise<GhecMigration> {
  const result = await gql<{ node: GhecMigration }>(
    `query($id: ID!) {
			node(id: $id) {
				... on Migration {
					id, sourceUrl, migrationLogUrl,
					migrationSource { name },
					state, warningsCount, failureReason, repositoryName
				}
			}
		}`,
    { id: migrationId },
  );
  return result.node;
}

export async function abortMigration(gql: typeof graphql, migrationId: string): Promise<boolean> {
  const result = await gql<{ abortRepositoryMigration: { success: boolean } }>(
    `mutation($migrationId: ID!) {
			abortRepositoryMigration(input: { migrationId: $migrationId }) { success }
		}`,
    { migrationId },
  );
  return result.abortRepositoryMigration.success;
}

export async function getRepoNodeId(
  gql: typeof graphql,
  owner: string,
  name: string,
): Promise<string> {
  const result = await gql<{ repository: { id: string } }>(
    `query($owner: String!, $name: String!) {
			repository(owner: $owner, name: $name) { id }
		}`,
    { owner, name },
  );
  return result.repository.id;
}

export async function archiveRepository(gql: typeof graphql, repoNodeId: string): Promise<boolean> {
  const result = await gql<{ archiveRepository: { repository: { isArchived: boolean } } }>(
    `mutation($repositoryId: ID!) {
			archiveRepository(input: { repositoryId: $repositoryId }) {
				repository { isArchived }
			}
		}`,
    { repositoryId: repoNodeId },
  );
  return result.archiveRepository.repository.isArchived;
}
