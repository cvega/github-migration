import { downloadBitbucketArchive } from "./source/bitbucket/archive";
import { BitbucketServerApiError } from "./source/bitbucket/client";
import {
  getBitbucketServerSourceClient,
  getBitbucketServerSourceConfig,
} from "./source/bitbucket/config";
import { downloadGitLabArchive } from "./source/gitlab/archive";
import { GitLabApiError } from "./source/gitlab/client";
import { getGitLabSourceClient } from "./source/gitlab/config";

export interface GitLabMigrationSourceClient {
  apiUrl: string;
  startProjectExport(projectPath: string, signal?: AbortSignal): Promise<void>;
  getProjectExport(
    projectPath: string,
    signal?: AbortSignal,
  ): Promise<{
    state: "none" | "queued" | "started" | "finished" | "regeneration_in_progress" | "failed";
  }>;
  downloadProjectExport(
    projectPath: string,
    destinationPath: string,
    options: { signal?: AbortSignal; maxBytes: number; timeoutMs: number },
  ): Promise<void>;
}

export interface GitLabGhesSourceClient {
  apiUrl: string;
  isProjectArchived(projectPath: string, signal?: AbortSignal): Promise<boolean>;
  unarchiveProject(projectPath: string, signal?: AbortSignal): Promise<void>;
}

export interface BitbucketMigrationSourceClient {
  apiUrl: string;
  startRepositoryExport(
    projectKey: string,
    repositorySlug: string,
    signal?: AbortSignal,
  ): Promise<string>;
  getRepositoryExport(
    exportId: string,
    signal?: AbortSignal,
  ): Promise<{
    id: string;
    state: string;
    message: string;
    percentage: number;
  }>;
}

export function getGitLabMigrationSourceClient(): GitLabMigrationSourceClient {
  return getGitLabSourceClient();
}

export function getGitLabGhesSourceClient(): GitLabGhesSourceClient {
  return getGitLabSourceClient();
}

export function getBitbucketMigrationSourceClient(): BitbucketMigrationSourceClient {
  return getBitbucketServerSourceClient();
}

export function getBitbucketMigrationSourceConfig(): { apiUrl: string; authAvailable: boolean } {
  return getBitbucketServerSourceConfig();
}

export function downloadGitLabMigrationArchive(
  client: GitLabMigrationSourceClient,
  projectPath: string,
  signal?: AbortSignal,
): Promise<string> {
  return downloadGitLabArchive(client, projectPath, signal);
}

export function downloadBitbucketMigrationArchive(
  exportId: string,
  signal?: AbortSignal,
): Promise<string> {
  return downloadBitbucketArchive(exportId, signal);
}

export function isDefinitiveGitLabApiError(error: unknown): boolean {
  return error instanceof GitLabApiError && error.status > 0;
}

export function isDefinitiveBitbucketApiError(error: unknown): boolean {
  return error instanceof BitbucketServerApiError && error.status > 0;
}
