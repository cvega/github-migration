import type { CreateMigrationRequest, Migration } from "$lib/migrate/types";
import type { GitHubClients } from "$lib/server/core/github";
import { sleep } from "$lib/server/core/polling";
import { requireMigrationTargetProfile } from "$lib/server/core/targets";
import {
  downloadGitLabMigrationArchive,
  type GitLabMigrationSourceClient,
  getGitLabMigrationSourceClient,
  isDefinitiveGitLabApiError,
} from "$lib/server/provider-runtime";
import { getSourceExportId, updateGitLabExportCheckpoint } from "../database/migrations";
import { abortRepositoryMigration, createGitLabMigrationSource } from "../github/migration-source";
import type { MigrationEventEmitter } from "../github/monitor";
import { monitorGhecMigration } from "./archive-to-ghec";
import {
  classifyNativeFailure,
  createRunningMigration,
  emitNativeStep,
  nativeToGhecDependencies,
  prepareNativeTarget,
  resumeNativeToGhecMigration,
  uploadAndExecuteNativeArchive,
} from "./native-to-ghec";

const defaultDependencies = {
  ...nativeToGhecDependencies,
  abortMigration: abortRepositoryMigration,
  createMigrationSource: createGitLabMigrationSource,
  downloadArchive: downloadGitLabMigrationArchive,
  getSourceClient: getGitLabMigrationSourceClient,
  isDefinitiveApiError: isDefinitiveGitLabApiError,
  monitorGhecMigration,
  requireTargetProfile: requireMigrationTargetProfile,
  updateGitLabExportCheckpoint,
  wait: sleep,
};
let dependencies = { ...defaultDependencies };
const EXPORT_POLL_INTERVAL_MS = 10_000;
const EXPORT_TIMEOUT_MS = 6 * 60 * 60 * 1_000;

export function __setGitLabToGhecDependenciesForTests(
  overrides: Partial<typeof defaultDependencies>,
): () => void {
  dependencies = { ...defaultDependencies, ...overrides };
  return () => {
    dependencies = { ...defaultDependencies };
  };
}

function recoveredRequest(migration: Migration): GitLabToGhecOptions {
  return {
    sourceProvider: "gitlab",
    sourceApiUrl: migration.sourceApiUrl,
    sourceRepo: projectPath(migration),
    targetProfileId: migration.targetProfileId,
    targetOrg: migration.targetOrg,
    targetRepo: migration.targetRepo,
    emit: () => {},
  };
}

export async function resumeGitLabToGhecMigration(
  migration: Migration,
  emit: MigrationEventEmitter,
  signal?: AbortSignal,
): Promise<Migration> {
  const options = { ...recoveredRequest(migration), signal, emit };
  return resumeNativeToGhecMigration({
    request: options,
    migration,
    dependencies,
    validateSourceCheckpoint: () => {
      if (getSourceExportId(migration.id) !== "gitlab") {
        throw new Error(
          `Cannot resume migration ${migration.id}: missing GitLab export checkpoint`,
        );
      }
    },
    getSourceClient: dependencies.getSourceClient,
    sourceUrlChangedMessage: `Cannot resume migration ${migration.id}: GitLab source URL changed`,
    resumeMessage: () => "Resuming GitLab export",
    executeFromExport: (sourceClient, clients, markRemoteStartMayHaveSucceeded) =>
      executeFromExport(options, migration, sourceClient, clients, markRemoteStartMayHaveSucceeded),
  });
}

export interface GitLabToGhecOptions extends CreateMigrationRequest {
  id?: string;
  signal?: AbortSignal;
  emit: MigrationEventEmitter;
}

function projectPath(migration: Migration): string {
  return `${migration.sourceOrg}/${migration.sourceRepo}`;
}

function gitLabWebUrl(apiUrl: string, path: string): string {
  const url = new URL(apiUrl);
  if (!url.pathname.endsWith("/api/v4")) throw new TypeError("Invalid GitLab API URL");
  url.pathname = `${url.pathname.slice(0, -7).replace(/\/+$/, "")}/${path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function createMigration(options: GitLabToGhecOptions, apiUrl: string): Migration {
  if (options.sourceProvider !== "gitlab") {
    throw new TypeError("GitLab executor requires sourceProvider 'gitlab'");
  }
  const profile = dependencies.requireTargetProfile(options.targetProfileId);
  if (profile.platform !== "ghec") throw new TypeError("GitLab-to-GHEC requires a GHEC target");
  return createRunningMigration({
    request: options,
    sourceProvider: "gitlab",
    sourceApiUrl: apiUrl,
    targetProfile: profile,
  });
}

function assertSupportedOptions(options: GitLabToGhecOptions): void {
  if (options.sourceToken || options.sourceApp) {
    throw new TypeError("GitLab source credentials must be configured on the server");
  }
  if (
    options.noSslVerify ||
    options.lockSource ||
    options.archiveSource ||
    options.directPassthrough ||
    options.gitArchivePath ||
    options.metadataArchivePath
  ) {
    throw new TypeError("GitLab migrations do not support GitHub archive or source-lock options");
  }
}

async function waitForExport(
  client: GitLabMigrationSourceClient,
  migration: Migration,
  signal: AbortSignal | undefined,
  emit: MigrationEventEmitter,
): Promise<void> {
  const deadline = Date.now() + EXPORT_TIMEOUT_MS;
  let previousState = "";
  while (true) {
    signal?.throwIfAborted();
    const { state } = await client.getProjectExport(projectPath(migration), signal);
    if (state === "finished") return;
    if (state === "failed") throw new Error("GitLab export failed");
    if (Date.now() >= deadline) throw new Error("GitLab export timed out");
    if (state !== previousState) {
      emitNativeStep(emit, migration.id, `GitLab export status: ${state}`);
      previousState = state;
    }
    await dependencies.wait(EXPORT_POLL_INTERVAL_MS, signal);
  }
}

async function executeFromExport(
  options: GitLabToGhecOptions,
  migration: Migration,
  client: GitLabMigrationSourceClient,
  clients: GitHubClients,
  markRemoteStartMayHaveSucceeded: (unknown: boolean) => void,
): Promise<Migration> {
  await waitForExport(client, migration, options.signal, options.emit);
  dependencies.updateGitLabExportCheckpoint(migration.id, "source_export_ready");
  emitNativeStep(options.emit, migration.id, "GitLab export completed");
  const archivePath = await dependencies.downloadArchive(
    client,
    projectPath(migration),
    options.signal,
  );
  return uploadAndExecuteNativeArchive({
    request: options,
    migration,
    clients,
    archivePath,
    archiveName: `GitLab_export_${migration.id}.tar.gz`,
    uploadMessage: "Uploading GitLab archive to GitHub storage",
    sourceRepoUrl: gitLabWebUrl(client.apiUrl, projectPath(migration)),
    metadataArchiveUrl: "",
    createMigrationSource: dependencies.createMigrationSource,
    signal: options.signal,
    emit: options.emit,
    dependencies,
    markRemoteStartMayHaveSucceeded,
  });
}

export async function runGitLabToGhecMigration(options: GitLabToGhecOptions): Promise<Migration> {
  assertSupportedOptions(options);
  const sourceClient = dependencies.getSourceClient();
  const migration = createMigration(options, sourceClient.apiUrl);
  let clients: GitHubClients | null = null;
  let sourceWriteMayHaveSucceeded = false;
  let remoteStartMayHaveSucceeded = false;
  try {
    clients = await prepareNativeTarget(options, migration, dependencies);
    sourceWriteMayHaveSucceeded = true;
    await sourceClient.startProjectExport(projectPath(migration), options.signal);
    dependencies.updateGitLabExportCheckpoint(migration.id, "source_export");
    sourceWriteMayHaveSucceeded = false;
    emitNativeStep(options.emit, migration.id, "GitLab export started");
    return executeFromExport(options, migration, sourceClient, clients, (unknown) => {
      remoteStartMayHaveSucceeded = unknown;
    });
  } catch (error) {
    if (dependencies.isDefinitiveApiError(error)) sourceWriteMayHaveSucceeded = false;
    return classifyNativeFailure({
      error,
      signal: options.signal,
      migration,
      clients,
      sourceWriteMayHaveSucceeded,
      remoteStartMayHaveSucceeded,
      abortMigration: async (targetClients, migrationId) =>
        dependencies.abortMigration(targetClients.targetGraphql, migrationId),
    });
  }
}
