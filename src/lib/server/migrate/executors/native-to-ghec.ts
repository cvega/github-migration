import { rm } from "node:fs/promises";
import type { AuthMode, CreateMigrationRequest, Migration } from "$lib/migrate/types";
import type { MigrationTargetProfile } from "$lib/migration-target";
import { resolveTargetAuth } from "$lib/server/core/auth";
import {
  createClients,
  doesOrgExist,
  doesRepoExist,
  type GitHubClients,
} from "$lib/server/core/github";
import type { SourceProvider } from "$lib/source/types";
import { getSourceProjectIdentity } from "$lib/source-provider";
import { updateCheckpoint } from "../database/migrations";
import { type abortRepositoryMigration, getOrgDatabaseId } from "../github/migration-source";
import type { MigrationEventEmitter } from "../github/monitor";
import { uploadArchive } from "../github/upload";
import { executeArchiveToGhec, type monitorGhecMigration } from "./archive-to-ghec";

const PLACEHOLDER_SOURCE_TOKEN = "not-used";

export interface NativeToGhecDependencies {
  resolveTargetAuth: typeof resolveTargetAuth;
  createClients: typeof createClients;
  doesOrgExist: typeof doesOrgExist;
  doesRepoExist: typeof doesRepoExist;
  getOrgDatabaseId: typeof getOrgDatabaseId;
  uploadArchive: typeof uploadArchive;
  executeArchiveToGhec: typeof executeArchiveToGhec;
  updateCheckpoint: typeof updateCheckpoint;
}

export const nativeToGhecDependencies: NativeToGhecDependencies = {
  resolveTargetAuth,
  createClients,
  doesOrgExist,
  doesRepoExist,
  getOrgDatabaseId,
  uploadArchive,
  executeArchiveToGhec,
  updateCheckpoint,
};

export function createRunningMigration(input: {
  request: CreateMigrationRequest & { id?: string };
  sourceProvider: SourceProvider;
  sourceApiUrl: string;
  targetProfile: MigrationTargetProfile;
}): Migration {
  const identity = getSourceProjectIdentity(input.sourceProvider, input.request.sourceRepo);
  return {
    id: input.request.id ?? Bun.randomUUIDv7(),
    batchId: null,
    githubMigrationId: null,
    sourceProvider: input.sourceProvider,
    sourceApiUrl: input.sourceApiUrl,
    targetProfileId: input.targetProfile.id,
    targetPlatform: input.targetProfile.platform,
    targetApiUrl: input.targetProfile.apiUrl,
    sourceOrg: identity.namespace,
    sourceRepo: identity.name,
    targetOrg: input.request.targetOrg,
    targetRepo: input.request.targetRepo || identity.name,
    state: "running",
    failureReason: null,
    migrationLogUrl: null,
    warningsCount: 0,
    sourceCounts: null,
    targetCounts: null,
    sourceSizeKb: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    elapsedSeconds: null,
    authMode: null,
    requestOptions: null,
  };
}

export function emitNativeStep(
  emit: MigrationEventEmitter,
  migrationId: string,
  message: string,
): void {
  emit({
    migrationId,
    eventType: "step",
    phase: null,
    payload: { message },
    createdAt: new Date().toISOString(),
  });
}

function nativeTargetAuthMode(
  request: CreateMigrationRequest,
  dependencies: Pick<NativeToGhecDependencies, "resolveTargetAuth">,
): AuthMode {
  if (request.targetToken) return "request-pat";
  if (request.targetApp) return "request-app";
  return dependencies.resolveTargetAuth().appId ? "env-app" : "env-pat";
}

function createNativeTargetClients(
  request: CreateMigrationRequest,
  targetApiUrl: string,
  dependencies: Pick<NativeToGhecDependencies, "resolveTargetAuth" | "createClients">,
): GitHubClients {
  const targetAuth = dependencies.resolveTargetAuth(request.targetToken, request.targetApp);
  return dependencies.createClients({
    sourceApiUrl: targetApiUrl,
    sourceAuth: targetAuth,
    targetApiUrl,
    targetAuth,
  });
}

export async function prepareNativeTarget(
  request: CreateMigrationRequest & { signal?: AbortSignal; emit: MigrationEventEmitter },
  migration: Migration,
  dependencies: Pick<
    NativeToGhecDependencies,
    "resolveTargetAuth" | "createClients" | "doesOrgExist" | "doesRepoExist" | "updateCheckpoint"
  >,
): Promise<GitHubClients> {
  const clients = createNativeTargetClients(request, migration.targetApiUrl, dependencies);
  dependencies.updateCheckpoint(migration.id, "preflight", {
    authMode: nativeTargetAuthMode(request, dependencies),
  });
  if (!(await dependencies.doesOrgExist(clients.target, migration.targetOrg))) {
    throw new Error(`Target organization "${migration.targetOrg}" does not exist on GHEC`);
  }
  if (await dependencies.doesRepoExist(clients.target, migration.targetOrg, migration.targetRepo)) {
    emitNativeStep(
      request.emit,
      migration.id,
      `Target repo ${migration.targetOrg}/${migration.targetRepo} already exists`,
    );
  }
  request.signal?.throwIfAborted();
  dependencies.updateCheckpoint(migration.id, "source_export");
  return clients;
}

export async function resumeNativeToGhecMigration<SourceClient extends { apiUrl: string }>(input: {
  request: CreateMigrationRequest & { signal?: AbortSignal; emit: MigrationEventEmitter };
  migration: Migration;
  dependencies: Pick<NativeToGhecDependencies, "resolveTargetAuth" | "createClients"> & {
    abortMigration: typeof abortRepositoryMigration;
    monitorGhecMigration: typeof monitorGhecMigration;
  };
  validateSourceCheckpoint: () => void;
  getSourceClient: () => SourceClient;
  sourceUrlChangedMessage: string;
  resumeMessage: () => string;
  executeFromExport: (
    sourceClient: SourceClient,
    clients: GitHubClients,
    markRemoteStartMayHaveSucceeded: (unknown: boolean) => void,
  ) => Promise<Migration>;
}): Promise<Migration> {
  let clients: GitHubClients | null = null;
  let remoteStartMayHaveSucceeded = false;
  try {
    clients = createNativeTargetClients(
      input.request,
      input.migration.targetApiUrl,
      input.dependencies,
    );
    if (input.migration.githubMigrationId) {
      emitNativeStep(
        input.request.emit,
        input.migration.id,
        `Reconnecting to in-flight migration ${input.migration.githubMigrationId}`,
      );
      return input.dependencies.monitorGhecMigration(
        clients,
        input.migration,
        input.migration.githubMigrationId,
        input.request.emit,
        input.request.signal,
      );
    }
    input.validateSourceCheckpoint();
    const sourceClient = input.getSourceClient();
    if (sourceClient.apiUrl !== input.migration.sourceApiUrl) {
      throw new Error(input.sourceUrlChangedMessage);
    }
    emitNativeStep(input.request.emit, input.migration.id, input.resumeMessage());
    return input.executeFromExport(sourceClient, clients, (unknown) => {
      remoteStartMayHaveSucceeded = unknown;
    });
  } catch (error) {
    return classifyNativeFailure({
      error,
      signal: input.request.signal,
      migration: input.migration,
      clients,
      sourceWriteMayHaveSucceeded: false,
      remoteStartMayHaveSucceeded,
      abortMigration: async (targetClients, migrationId) =>
        input.dependencies.abortMigration(targetClients.targetGraphql, migrationId),
    });
  }
}

export async function uploadAndExecuteNativeArchive(input: {
  request: CreateMigrationRequest;
  migration: Migration;
  clients: GitHubClients;
  archivePath: string;
  archiveName: string;
  uploadMessage: string;
  sourceRepoUrl: string;
  metadataArchiveUrl: string;
  createMigrationSource: Parameters<typeof executeArchiveToGhec>[0]["createMigrationSource"];
  signal?: AbortSignal;
  emit: MigrationEventEmitter;
  dependencies: NativeToGhecDependencies;
  markRemoteStartMayHaveSucceeded?: (unknown: boolean) => void;
}): Promise<Migration> {
  try {
    input.dependencies.updateCheckpoint(input.migration.id, "archive_upload");
    emitNativeStep(input.emit, input.migration.id, input.uploadMessage);
    const organizationId = await input.dependencies.getOrgDatabaseId(
      input.clients.targetGraphql,
      input.migration.targetOrg,
    );
    const targetToken = await input.clients.getTargetToken();
    const gitArchiveUrl = await input.dependencies.uploadArchive(
      Bun.file(input.archivePath),
      input.archiveName,
      organizationId,
      targetToken,
      undefined,
      input.signal,
    );
    return await input.dependencies.executeArchiveToGhec({
      clients: input.clients,
      migration: input.migration,
      request: input.request,
      sourceRepoUrl: input.sourceRepoUrl,
      sourceToken: PLACEHOLDER_SOURCE_TOKEN,
      targetToken,
      gitArchiveUrl,
      metadataArchiveUrl: input.metadataArchiveUrl,
      signal: input.signal,
      emit: input.emit,
      createMigrationSource: input.createMigrationSource,
      markRemoteStartMayHaveSucceeded: input.markRemoteStartMayHaveSucceeded,
    });
  } finally {
    await rm(input.archivePath, { force: true }).catch(() => {});
  }
}

export async function classifyNativeFailure(input: {
  error: unknown;
  signal?: AbortSignal;
  migration: Migration;
  clients: GitHubClients | null;
  sourceWriteMayHaveSucceeded: boolean;
  remoteStartMayHaveSucceeded: boolean;
  abortMigration: (clients: GitHubClients, migrationId: string) => Promise<boolean>;
}): Promise<Migration> {
  const cancelled = input.signal?.aborted ?? false;
  if (cancelled && input.migration.githubMigrationId && input.clients) {
    try {
      input.migration.state = (await input.abortMigration(
        input.clients,
        input.migration.githubMigrationId,
      ))
        ? "cancelled"
        : "reconciliation_required";
    } catch (error) {
      input.migration.state = "reconciliation_required";
      input.migration.failureReason = error instanceof Error ? error.message : String(error);
    }
  } else if (
    input.sourceWriteMayHaveSucceeded ||
    input.remoteStartMayHaveSucceeded ||
    input.migration.githubMigrationId
  ) {
    input.migration.state = "reconciliation_required";
  } else {
    input.migration.state = cancelled ? "cancelled" : "failed";
  }
  if (!input.migration.failureReason && input.migration.state !== "cancelled") {
    input.migration.failureReason =
      input.error instanceof Error ? input.error.message : String(input.error);
  }
  input.migration.completedAt = new Date().toISOString();
  input.migration.elapsedSeconds =
    (Date.now() - new Date(input.migration.startedAt).getTime()) / 1_000;
  return input.migration;
}
