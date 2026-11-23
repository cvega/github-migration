import type { CreateMigrationRequest, Migration } from "$lib/migrate/types";
import type { GitHubClients } from "$lib/server/core/github";
import { sleep } from "$lib/server/core/polling";
import { requireMigrationTargetProfile } from "$lib/server/core/targets";
import {
  type BitbucketMigrationSourceClient,
  downloadBitbucketMigrationArchive,
  getBitbucketMigrationSourceClient,
  isDefinitiveBitbucketApiError,
} from "$lib/server/migrate/ports/source-runtime";
import { getSourceExportId, updateSourceExportCheckpoint } from "../database/migrations";
import {
  abortRepositoryMigration,
  createBitbucketMigrationSource,
} from "../github/migration-source";
import type { MigrationEventEmitter } from "../github/monitor";
import { emitNativeStep } from "../runs/events";
import { monitorGhecMigration } from "./archive-to-ghec";
import {
  classifyNativeFailure,
  createRunningMigration,
  nativeToGhecDependencies,
  prepareNativeTarget,
  resumeNativeToGhecMigration,
  uploadAndExecuteNativeArchive,
} from "./native-to-ghec";

const defaultDependencies = {
  ...nativeToGhecDependencies,
  abortMigration: abortRepositoryMigration,
  createMigrationSource: createBitbucketMigrationSource,
  downloadArchive: downloadBitbucketMigrationArchive,
  getSourceClient: getBitbucketMigrationSourceClient,
  isDefinitiveApiError: isDefinitiveBitbucketApiError,
  monitorGhecMigration,
  requireTargetProfile: requireMigrationTargetProfile,
  updateSourceExportCheckpoint,
  wait: sleep,
};
let dependencies = { ...defaultDependencies };
const EXPORT_POLL_INTERVAL_MS = 60_000;
const EXPORT_TIMEOUT_MS = 6 * 60 * 60 * 1_000;

export function __setBitbucketToGhecDependenciesForTests(
  overrides: Partial<typeof defaultDependencies>,
): () => void {
  dependencies = { ...defaultDependencies, ...overrides };
  return () => {
    dependencies = { ...defaultDependencies };
  };
}

export interface BitbucketToGhecOptions extends CreateMigrationRequest {
  id?: string;
  signal?: AbortSignal;
  emit: MigrationEventEmitter;
}

function createMigration(options: BitbucketToGhecOptions, apiUrl: string): Migration {
  if (options.sourceProvider !== "bitbucket-server") {
    throw new TypeError("Bitbucket executor requires sourceProvider 'bitbucket-server'");
  }
  if (options.sourceToken || options.sourceApp) {
    throw new TypeError("Bitbucket source credentials must be configured on the server");
  }
  const profile = dependencies.requireTargetProfile(options.targetProfileId);
  if (profile.platform !== "ghec") {
    throw new TypeError("Bitbucket-to-GHEC requires a GHEC target");
  }
  return createRunningMigration({
    request: options,
    sourceProvider: "bitbucket-server",
    sourceApiUrl: apiUrl,
    targetProfile: profile,
  });
}

function bitbucketWebUrl(apiUrl: string, migration: Migration): string {
  const url = new URL(apiUrl);
  if (!url.pathname.endsWith("/rest/api/1.0")) {
    throw new TypeError("Invalid Bitbucket Server API URL");
  }
  url.pathname = url.pathname.slice(0, -13) || "/";
  url.search = "";
  url.hash = "";
  const base = url.toString().replace(/\/$/, "");
  return `${base}/projects/${encodeURIComponent(migration.sourceOrg)}/repos/${encodeURIComponent(migration.sourceRepo)}/browse`;
}

async function waitForExport(
  client: BitbucketMigrationSourceClient,
  exportId: string,
  migration: Migration,
  signal: AbortSignal | undefined,
  emit: MigrationEventEmitter,
): Promise<void> {
  const deadline = Date.now() + EXPORT_TIMEOUT_MS;
  let previousProgress = "";
  while (true) {
    signal?.throwIfAborted();
    const status = await client.getRepositoryExport(exportId, signal);
    if (status.state === "COMPLETED") return;
    if (status.state === "FAILED" || status.state === "ABORTED") {
      throw new Error(
        `Bitbucket export ${exportId} ${status.state.toLowerCase()}${status.message ? `: ${status.message}` : ""}`,
      );
    }
    if (Date.now() >= deadline) throw new Error(`Bitbucket export ${exportId} timed out`);
    const progress = `${status.percentage}:${status.message}`;
    if (progress !== previousProgress) {
      emitNativeStep(
        emit,
        migration.id,
        `Bitbucket export ${status.percentage}%${status.message ? `: ${status.message}` : ""}`,
      );
      previousProgress = progress;
    }
    await dependencies.wait(EXPORT_POLL_INTERVAL_MS, signal);
  }
}

async function executeFromExport(
  options: BitbucketToGhecOptions,
  migration: Migration,
  exportId: string,
  client: BitbucketMigrationSourceClient,
  clients: GitHubClients,
  markRemoteStartMayHaveSucceeded: (unknown: boolean) => void,
): Promise<Migration> {
  await waitForExport(client, exportId, migration, options.signal, options.emit);
  dependencies.updateSourceExportCheckpoint(migration.id, "source_export_ready", exportId);
  emitNativeStep(options.emit, migration.id, `Bitbucket export ${exportId} completed`);
  const archivePath = await dependencies.downloadArchive(exportId, options.signal);
  return uploadAndExecuteNativeArchive({
    request: options,
    migration,
    clients,
    archivePath,
    archiveName: `Bitbucket_export_${exportId}.tar`,
    uploadMessage: "Uploading Bitbucket archive to GitHub storage",
    sourceRepoUrl: bitbucketWebUrl(client.apiUrl, migration),
    metadataArchiveUrl: "https://not-used",
    createMigrationSource: dependencies.createMigrationSource,
    signal: options.signal,
    emit: options.emit,
    dependencies,
    markRemoteStartMayHaveSucceeded,
  });
}

export async function runBitbucketToGhecMigration(
  options: BitbucketToGhecOptions,
): Promise<Migration> {
  const sourceClient = dependencies.getSourceClient();
  const migration = createMigration(options, sourceClient.apiUrl);
  let clients: GitHubClients | null = null;
  let sourceWriteMayHaveSucceeded = false;
  let remoteStartMayHaveSucceeded = false;
  try {
    clients = await prepareNativeTarget(options, migration, dependencies);
    sourceWriteMayHaveSucceeded = true;
    const exportId = await sourceClient.startRepositoryExport(
      migration.sourceOrg,
      migration.sourceRepo,
      options.signal,
    );
    dependencies.updateSourceExportCheckpoint(migration.id, "source_export", exportId);
    sourceWriteMayHaveSucceeded = false;
    emitNativeStep(options.emit, migration.id, `Bitbucket export ${exportId} started`);
    return executeFromExport(options, migration, exportId, sourceClient, clients, (unknown) => {
      remoteStartMayHaveSucceeded = unknown;
    });
  } catch (error) {
    if (dependencies.isDefinitiveApiError(error)) {
      sourceWriteMayHaveSucceeded = false;
    }
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

function recoveredRequest(migration: Migration): BitbucketToGhecOptions {
  return {
    sourceProvider: "bitbucket-server",
    sourceApiUrl: migration.sourceApiUrl,
    sourceRepo: `${migration.sourceOrg}/${migration.sourceRepo}`,
    targetProfileId: migration.targetProfileId,
    targetOrg: migration.targetOrg,
    targetRepo: migration.targetRepo,
    emit: () => {},
  };
}

export async function resumeBitbucketToGhecMigration(
  migration: Migration,
  emit: MigrationEventEmitter,
  signal?: AbortSignal,
): Promise<Migration> {
  const options = { ...recoveredRequest(migration), signal, emit };
  let exportId = "";
  return resumeNativeToGhecMigration({
    request: options,
    migration,
    dependencies,
    validateSourceCheckpoint: () => {
      exportId = getSourceExportId(migration.id) ?? "";
      if (!exportId) {
        throw new Error(`Cannot resume migration ${migration.id}: missing source export ID`);
      }
    },
    getSourceClient: dependencies.getSourceClient,
    sourceUrlChangedMessage: `Cannot resume migration ${migration.id}: Bitbucket source URL changed`,
    resumeMessage: () => `Resuming Bitbucket export ${exportId}`,
    executeFromExport: (sourceClient, clients, markRemoteStartMayHaveSucceeded) =>
      executeFromExport(
        options,
        migration,
        exportId,
        sourceClient,
        clients,
        markRemoteStartMayHaveSucceeded,
      ),
  });
}
