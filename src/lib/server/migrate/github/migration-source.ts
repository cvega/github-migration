import type { graphql } from "@octokit/graphql";

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

export async function createGitHubMigrationSource(
  gql: typeof graphql,
  orgId: string,
): Promise<string> {
  return createTypedMigrationSource(gql, orgId, {
    name: "GHEC Source",
    sourceUrl: "https://github.com",
    type: "GITHUB_ARCHIVE",
  });
}

export async function createBitbucketMigrationSource(
  gql: typeof graphql,
  orgId: string,
): Promise<string> {
  return createTypedMigrationSource(gql, orgId, {
    name: "Bitbucket Server Source",
    sourceUrl: "https://not-used",
    type: "BITBUCKET_SERVER",
  });
}

export async function createGitLabMigrationSource(
  gql: typeof graphql,
  orgId: string,
): Promise<string> {
  return createTypedMigrationSource(gql, orgId, {
    name: "GitLab Source",
    sourceUrl: "https://not-used",
    type: "GITLAB",
  });
}

async function createTypedMigrationSource(
  gql: typeof graphql,
  orgId: string,
  source: { name: string; sourceUrl: string; type: string },
): Promise<string> {
  const result = await gql<{ createMigrationSource: { migrationSource: { id: string } } }>(
    `mutation($name: String!, $sourceUrl: String!, $ownerId: ID!, $type: MigrationSourceType!) {
			createMigrationSource(input: { name: $name, url: $sourceUrl, ownerId: $ownerId, type: $type }) {
				migrationSource { id }
			}
		}`,
    { name: source.name, sourceUrl: source.sourceUrl, ownerId: orgId, type: source.type },
  );
  return result.createMigrationSource.migrationSource.id;
}

export interface StartMigrationOptions {
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

export async function startRepositoryMigration(
  gql: typeof graphql,
  options: StartMigrationOptions,
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
			skipReleases: $skipReleases, targetRepoVisibility: $targetRepoVisibility,
			lockSource: $lockSource
		}) { repositoryMigration { id } }
	}`;
  const result = await gql<{
    startRepositoryMigration: { repositoryMigration: { id: string } };
  }>(mutation, {
    // A 5xx can arrive after acceptance; do not replay this mutation in the SDK.
    request: { retries: 0 },
    sourceId: options.migrationSourceId,
    ownerId: options.orgId,
    sourceRepositoryUrl: options.sourceRepoUrl,
    repositoryName: options.repoName,
    continueOnError: true,
    gitArchiveUrl: options.gitArchiveUrl || null,
    metadataArchiveUrl: options.metadataArchiveUrl || null,
    accessToken: options.sourceToken,
    githubPat: options.targetToken,
    skipReleases: options.skipReleases ?? false,
    targetRepoVisibility: options.targetRepoVisibility || null,
    lockSource: options.lockSource ?? false,
  });
  return result.startRepositoryMigration.repositoryMigration.id;
}

export interface GitHubMigrationStatus {
  state: string;
  repositoryName: string;
  warningsCount: number;
  failureReason: string;
  migrationLogUrl: string;
}

export async function getRepositoryMigration(
  gql: typeof graphql,
  migrationId: string,
): Promise<GitHubMigrationStatus> {
  const result = await gql<{ node: GitHubMigrationStatus }>(
    `query($id: ID!) {
			node(id: $id) {
				... on Migration {
					id, sourceUrl, migrationLogUrl, migrationSource { name },
					state, warningsCount, failureReason, repositoryName
				}
			}
		}`,
    { id: migrationId },
  );
  return result.node;
}

export async function abortRepositoryMigration(
  gql: typeof graphql,
  migrationId: string,
): Promise<boolean> {
  const result = await gql<{ abortRepositoryMigration: { success: boolean } }>(
    `mutation($migrationId: ID!) {
			abortRepositoryMigration(input: { migrationId: $migrationId }) { success }
		}`,
    { migrationId },
  );
  return result.abortRepositoryMigration.success;
}

export async function getRepositoryNodeId(
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

export async function archiveRepository(
  gql: typeof graphql,
  repositoryId: string,
): Promise<boolean> {
  const result = await gql<{ archiveRepository: { repository: { isArchived: boolean } } }>(
    `mutation($repositoryId: ID!) {
			archiveRepository(input: { repositoryId: $repositoryId }) {
				repository { isArchived }
			}
		}`,
    { repositoryId },
  );
  return result.archiveRepository.repository.isArchived;
}
