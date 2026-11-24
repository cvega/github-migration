import type { CreateMigrationRequest, Migration } from "$lib/migrate/types";
import type { GitHubTargetClients } from "$lib/server/core/github";
import { getRepoCounts } from "$lib/server/core/github";
import { updateCheckpoint } from "../database/migrations";
import {
  createGitHubMigrationSource,
  getOrgId,
  startRepositoryMigration,
} from "../github/migration-source";
import { type MigrationEventEmitter, monitorRepositoryMigration } from "../github/monitor";

const defaultDependencies = {
  createMigrationSource: createGitHubMigrationSource,
  getOrgId,
  getRepoCounts,
  monitor: monitorRepositoryMigration,
  startMigration: startRepositoryMigration,
  updateCheckpoint,
};
let dependencies = { ...defaultDependencies };

export function __setArchiveToGhecDependenciesForTests(
  overrides: Partial<typeof defaultDependencies>,
): () => void {
  dependencies = { ...defaultDependencies, ...overrides };
  return () => {
    dependencies = { ...defaultDependencies };
  };
}

export interface ArchiveToGhecOptions {
  clients: GitHubTargetClients;
  migration: Migration;
  request: Pick<CreateMigrationRequest, "lockSource" | "skipReleases" | "targetRepoVisibility">;
  sourceRepoUrl: string;
  sourceToken: string;
  targetToken: string;
  gitArchiveUrl: string;
  metadataArchiveUrl: string;
  signal?: AbortSignal;
  emit: MigrationEventEmitter;
  createMigrationSource?: typeof createGitHubMigrationSource;
  markRemoteStartMayHaveSucceeded?: (unknown: boolean) => void;
}

function emitStep(options: ArchiveToGhecOptions, message: string): void {
  options.emit({
    migrationId: options.migration.id,
    eventType: "step",
    phase: null,
    payload: { message },
    createdAt: new Date().toISOString(),
  });
}

export async function monitorGhecMigration(
  clients: GitHubTargetClients,
  migration: Migration,
  githubMigrationId: string,
  emit: MigrationEventEmitter,
  signal?: AbortSignal,
): Promise<Migration> {
  const { phase, finalCounts } = await dependencies.monitor({
    clients,
    migrationId: migration.id,
    githubMigrationId,
    targetOrg: migration.targetOrg,
    targetRepo: migration.targetRepo,
    sourceCounts: migration.sourceCounts,
    signal,
    emit,
  });

  if (phase === "FAILED") {
    migration.state = "failed";
    migration.failureReason = "Migration failed on GHEC";
  } else if (phase === "SUCCEEDED") {
    migration.state = "succeeded";
    if (finalCounts) {
      migration.targetCounts = finalCounts;
    } else {
      try {
        migration.targetCounts = await dependencies.getRepoCounts(
          clients.target,
          clients.targetGraphql,
          migration.targetOrg,
          migration.targetRepo,
        );
      } catch {
        console.warn("Final target repository counts unavailable.");
      }
    }
  } else {
    throw new Error(signal?.aborted ? "Migration cancelled" : `Monitor exited in phase ${phase}`);
  }

  migration.completedAt = new Date().toISOString();
  migration.elapsedSeconds = (Date.now() - new Date(migration.startedAt).getTime()) / 1_000;
  return migration;
}

export async function executeArchiveToGhec(options: ArchiveToGhecOptions): Promise<Migration> {
  options.signal?.throwIfAborted();
  const organizationId = await dependencies.getOrgId(
    options.clients.targetGraphql,
    options.migration.targetOrg,
  );
  const migrationSourceId = await (
    options.createMigrationSource ?? dependencies.createMigrationSource
  )(options.clients.targetGraphql, organizationId);

  options.signal?.throwIfAborted();
  dependencies.updateCheckpoint(options.migration.id, "ghec_starting");
  options.markRemoteStartMayHaveSucceeded?.(true);
  const githubMigrationId = await dependencies.startMigration(options.clients.targetGraphql, {
    migrationSourceId,
    sourceRepoUrl: options.sourceRepoUrl,
    orgId: organizationId,
    repoName: options.migration.targetRepo,
    sourceToken: options.sourceToken,
    targetToken: options.targetToken,
    gitArchiveUrl: options.gitArchiveUrl,
    metadataArchiveUrl: options.metadataArchiveUrl,
    skipReleases: options.request.skipReleases,
    targetRepoVisibility: options.request.targetRepoVisibility,
    lockSource: options.request.lockSource,
  });

  options.migration.githubMigrationId = githubMigrationId;
  dependencies.updateCheckpoint(options.migration.id, "monitoring", { githubMigrationId });
  options.markRemoteStartMayHaveSucceeded?.(false);
  emitStep(options, `Migration started (${githubMigrationId})`);
  return monitorGhecMigration(
    options.clients,
    options.migration,
    githubMigrationId,
    options.emit,
    options.signal,
  );
}
