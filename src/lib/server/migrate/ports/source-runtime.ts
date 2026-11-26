import type { SourceUrlInput } from "$lib/server/core/credential-scope";

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

export interface MigrationSourceRuntime {
  resolveEffectiveSourceApiUrl(input: SourceUrlInput): string;
  getGitLabMigrationSourceClient(): GitLabMigrationSourceClient;
  getGitLabGhesSourceClient(): GitLabGhesSourceClient;
  getBitbucketMigrationSourceClient(): BitbucketMigrationSourceClient;
  getBitbucketMigrationSourceConfig(): { apiUrl: string; authAvailable: boolean };
  downloadGitLabMigrationArchive(
    client: GitLabMigrationSourceClient,
    projectPath: string,
    signal?: AbortSignal,
  ): Promise<string>;
  downloadBitbucketMigrationArchive(exportId: string, signal?: AbortSignal): Promise<string>;
  isDefinitiveGitLabApiError(error: unknown): boolean;
  isDefinitiveBitbucketApiError(error: unknown): boolean;
}

let runtime: MigrationSourceRuntime | undefined;

export function configureMigrationSourceRuntime(configuredRuntime: MigrationSourceRuntime): void {
  runtime = configuredRuntime;
}

function getRuntime(): MigrationSourceRuntime {
  if (!runtime) throw new Error("Migration source runtime is not configured");
  return runtime;
}

export function resolveEffectiveSourceApiUrl(input: SourceUrlInput): string {
  return getRuntime().resolveEffectiveSourceApiUrl(input);
}

export function getGitLabMigrationSourceClient(): GitLabMigrationSourceClient {
  return getRuntime().getGitLabMigrationSourceClient();
}

export function getGitLabGhesSourceClient(): GitLabGhesSourceClient {
  return getRuntime().getGitLabGhesSourceClient();
}

export function getBitbucketMigrationSourceClient(): BitbucketMigrationSourceClient {
  return getRuntime().getBitbucketMigrationSourceClient();
}

export function getBitbucketMigrationSourceConfig(): { apiUrl: string; authAvailable: boolean } {
  return getRuntime().getBitbucketMigrationSourceConfig();
}

export function downloadGitLabMigrationArchive(
  client: GitLabMigrationSourceClient,
  projectPath: string,
  signal?: AbortSignal,
): Promise<string> {
  return getRuntime().downloadGitLabMigrationArchive(client, projectPath, signal);
}

export function downloadBitbucketMigrationArchive(
  exportId: string,
  signal?: AbortSignal,
): Promise<string> {
  return getRuntime().downloadBitbucketMigrationArchive(exportId, signal);
}

export function isDefinitiveGitLabApiError(error: unknown): boolean {
  return getRuntime().isDefinitiveGitLabApiError(error);
}

export function isDefinitiveBitbucketApiError(error: unknown): boolean {
  return getRuntime().isDefinitiveBitbucketApiError(error);
}

/** Only explicit request rejections establish that an export was not accepted. */
export function isDefinitiveExportRejection(status: unknown): boolean {
  return typeof status === "number" && [400, 401, 403, 404, 405, 415, 422, 429].includes(status);
}
