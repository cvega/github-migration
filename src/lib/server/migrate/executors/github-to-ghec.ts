import type { CreateMigrationRequest, Migration, MigrationEvent } from "$lib/migrate/types";
import { resolveSourceAuth, resolveTargetAuth } from "$lib/server/core/auth";
import {
  createClients,
  doesOrgExist,
  doesRepoExist,
  type GitHubClients,
  getRepoCounts,
  getRepoSize,
  isGhecSource,
  sourceBaseUrl,
} from "$lib/server/core/github";
import { requireMigrationTargetProfile } from "$lib/server/core/targets";
import {
  tryParsePersistedRequestOptions,
  updateCheckpoint,
  updateMigrationSourceSize,
} from "../database/migrations";
import {
  checkGhesVersion,
  IncompleteArchivePairError,
  resolveMigrationArchives,
} from "../github/exports";
import {
  abortRepositoryMigration,
  archiveRepository,
  getRepositoryNodeId,
} from "../github/migration-source";
import type { MigrationEventEmitter } from "../github/monitor";
import { isDefinitiveExportRejection } from "../ports/source-runtime";
import { determineAuthModeFromRequest } from "../validate";
import { executeArchiveToGhec, monitorGhecMigration } from "./archive-to-ghec";
import { createRunningMigration } from "./native-to-ghec";

const defaultDependencies = {
  abortMigration: abortRepositoryMigration,
  archiveRepository,
  checkGhesVersion,
  createClients,
  doesOrgExist,
  doesRepoExist,
  executeArchiveToGhec,
  getRepoCounts,
  getRepoSize,
  getRepositoryNodeId,
  monitorGhecMigration,
  requireTargetProfile: requireMigrationTargetProfile,
  resolveArchives: resolveMigrationArchives,
  resolveSourceAuth,
  resolveTargetAuth,
  updateCheckpoint,
  updateMigrationSourceSize,
};
let dependencies = { ...defaultDependencies };

export function __setGitHubToGhecDependenciesForTests(
  overrides: Partial<typeof defaultDependencies>,
): () => void {
  dependencies = { ...defaultDependencies, ...overrides };
  return () => {
    dependencies = { ...defaultDependencies };
  };
}

export interface GitHubToGhecOptions extends CreateMigrationRequest {
  id?: string;
  signal?: AbortSignal;
  emit: MigrationEventEmitter;
}

function createMigration(options: GitHubToGhecOptions): Migration {
  if ((options.sourceProvider ?? "github") !== "github") {
    throw new TypeError("GitHub executor requires sourceProvider 'github'");
  }
  const targetProfile = dependencies.requireTargetProfile(options.targetProfileId);
  if (targetProfile.platform !== "ghec") {
    throw new TypeError("GitHub-to-GHEC executor requires a GHEC target profile");
  }
  return createRunningMigration({
    request: options,
    sourceProvider: "github",
    sourceApiUrl: options.sourceApiUrl || "https://api.github.com",
    targetProfile,
  });
}

function emitStep(
  emit: MigrationEventEmitter,
  migrationId: string,
  message: string,
  postTerminal?: Extract<MigrationEvent, { eventType: "step" }>["payload"]["postTerminal"],
): void {
  emit({
    migrationId,
    eventType: "step",
    phase: null,
    payload: { message, ...(postTerminal ? { postTerminal } : {}) },
    createdAt: new Date().toISOString(),
  });
}

async function preflight(
  clients: GitHubClients,
  migration: Migration,
  emit: MigrationEventEmitter,
): Promise<void> {
  if (!isGhecSource(migration.sourceApiUrl)) {
    const version = await dependencies.checkGhesVersion(clients.source);
    emitStep(emit, migration.id, `GHES version OK: ${version}`);
  }
  if (!(await dependencies.doesOrgExist(clients.target, migration.targetOrg))) {
    throw new Error(`Target organization "${migration.targetOrg}" does not exist on GHEC`);
  }
  if (await dependencies.doesRepoExist(clients.target, migration.targetOrg, migration.targetRepo)) {
    emitStep(
      emit,
      migration.id,
      `Target repo ${migration.targetOrg}/${migration.targetRepo} already exists - GitHub will reject the import if the name is taken. Delete or rename it on the target, then restart.`,
    );
  }
  emitStep(emit, migration.id, "Pre-flight checks passed");
}

async function cancelRemoteMigration(
  options: GitHubToGhecOptions,
  migration: Migration,
): Promise<void> {
  if (!migration.githubMigrationId) return;
  try {
    const clients = dependencies.createClients({
      sourceApiUrl: migration.sourceApiUrl,
      sourceAuth: dependencies.resolveSourceAuth(options.sourceToken, options.sourceApp),
      targetApiUrl: migration.targetApiUrl,
      targetAuth: dependencies.resolveTargetAuth(options.targetToken, options.targetApp),
      noSslVerify: options.noSslVerify,
    });
    const aborted = await dependencies.abortMigration(
      clients.targetGraphql,
      migration.githubMigrationId,
    );
    migration.state = aborted ? "cancelled" : "reconciliation_required";
    if (!aborted) migration.failureReason = "Remote migration could not be confirmed cancelled";
  } catch {
    migration.state = "reconciliation_required";
    migration.failureReason = "Remote migration could not be confirmed cancelled";
  }
}

function completeFailure(migration: Migration, reason: string): void {
  migration.completedAt = new Date().toISOString();
  migration.elapsedSeconds = (Date.now() - new Date(migration.startedAt).getTime()) / 1_000;
  migration.failureReason ||= reason;
}

export async function runGitHubToGhecMigration(options: GitHubToGhecOptions): Promise<Migration> {
  const migration = createMigration(options);
  let remoteStartMayHaveSucceeded = false;
  let sourceCheckpoint: "source_export" | "archive_upload" | undefined;
  let reason = "GitHub preflight failed; check the source version and source and target access";
  try {
    const clients = dependencies.createClients({
      sourceApiUrl: migration.sourceApiUrl,
      sourceAuth: dependencies.resolveSourceAuth(options.sourceToken, options.sourceApp),
      targetApiUrl: migration.targetApiUrl,
      targetAuth: dependencies.resolveTargetAuth(options.targetToken, options.targetApp),
      noSslVerify: options.noSslVerify,
    });
    emitStep(
      options.emit,
      migration.id,
      `Starting migration: ${migration.sourceOrg}/${migration.sourceRepo} -> ${migration.targetOrg}/${migration.targetRepo}`,
    );
    dependencies.updateCheckpoint(migration.id, "preflight", {
      authMode: determineAuthModeFromRequest(options),
    });
    await preflight(clients, migration, options.emit);

    try {
      migration.sourceCounts = await dependencies.getRepoCounts(
        clients.source,
        clients.sourceGraphql,
        migration.sourceOrg,
        migration.sourceRepo,
      );
    } catch {
      // Source counts are supplementary.
    }
    const sourceSizeKb = await dependencies.getRepoSize(
      clients.source,
      migration.sourceOrg,
      migration.sourceRepo,
    );
    if (sourceSizeKb !== null) {
      migration.sourceSizeKb = sourceSizeKb;
      dependencies.updateMigrationSourceSize(migration.id, sourceSizeKb);
    }

    reason = "Could not prepare source archives; check the source export and archive configuration";
    if (isGhecSource(migration.sourceApiUrl))
      dependencies.updateCheckpoint(migration.id, "archiving");
    const archives = await dependencies.resolveArchives(
      clients,
      migration,
      { ...options, signal: options.signal },
      (message) => emitStep(options.emit, migration.id, message),
      (pending) => {
        const step = pending ? "source_export" : "archive_upload";
        dependencies.updateCheckpoint(migration.id, step);
        sourceCheckpoint = step;
      },
    );
    reason = "Could not prepare the GHEC import; check source and target access";
    const [sourceToken, targetToken] = await Promise.all([
      clients.getSourceToken(),
      clients.getTargetToken(),
    ]);
    const result = await dependencies.executeArchiveToGhec({
      clients,
      migration,
      request: options,
      sourceRepoUrl: `${sourceBaseUrl(migration.sourceApiUrl)}/${migration.sourceOrg}/${migration.sourceRepo}`,
      sourceToken,
      targetToken,
      ...archives,
      signal: options.signal,
      emit: options.emit,
      markRemoteStartMayHaveSucceeded: (unknown) => {
        remoteStartMayHaveSucceeded = unknown;
      },
    });
    if (result.state !== "succeeded") return result;

    dependencies.updateCheckpoint(migration.id, "post_migration");
    if (options.archiveSource) {
      try {
        const repositoryId = await dependencies.getRepositoryNodeId(
          clients.sourceGraphql,
          migration.sourceOrg,
          migration.sourceRepo,
        );
        if (!(await dependencies.archiveRepository(clients.sourceGraphql, repositoryId))) {
          throw new Error("Source archival was not confirmed");
        }
        emitStep(
          options.emit,
          migration.id,
          `Source repository ${migration.sourceOrg}/${migration.sourceRepo} archived`,
          { operation: "source_archive", outcome: "succeeded" },
        );
      } catch {
        emitStep(
          options.emit,
          migration.id,
          "Source archival could not be confirmed; check the source repository",
          { operation: "source_archive", outcome: "failed" },
        );
      }
    }
    return result;
  } catch (error) {
    if (
      sourceCheckpoint === "source_export" &&
      !(error instanceof Error && "status" in error && isDefinitiveExportRejection(error.status))
    ) {
      migration.state = "reconciliation_required";
      reason =
        error instanceof IncompleteArchivePairError
          ? error.message
          : "Source export outcome is unknown; check the source before restarting";
    } else if (
      sourceCheckpoint === "archive_upload" &&
      !remoteStartMayHaveSucceeded &&
      !migration.githubMigrationId
    ) {
      migration.state = "reconciliation_required";
      reason = "Source exports were accepted; check the source exports before restarting";
    } else if (options.signal?.aborted) {
      reason = "Migration cancelled";
      if (migration.githubMigrationId) await cancelRemoteMigration(options, migration);
      else if (remoteStartMayHaveSucceeded) {
        migration.state = "reconciliation_required";
        migration.failureReason = "Remote migration start outcome is unknown";
      } else {
        migration.state = "cancelled";
      }
    } else if (remoteStartMayHaveSucceeded || migration.githubMigrationId) {
      migration.state = "reconciliation_required";
      reason = "GHEC import outcome is unknown; check the target before restarting";
    } else {
      migration.state = "failed";
    }
    completeFailure(migration, reason);
    if (migration.state === "failed") {
      options.emit({
        migrationId: migration.id,
        eventType: "failure",
        phase: "FAILED",
        payload: { error: migration.failureReason ?? undefined },
        createdAt: new Date().toISOString(),
      });
    }
    return migration;
  }
}

export async function resumeGitHubToGhecMigration(
  migration: Migration,
  emit: MigrationEventEmitter,
  signal?: AbortSignal,
): Promise<Migration> {
  if (!migration.githubMigrationId) {
    throw new Error(`Cannot resume migration ${migration.id}: missing githubMigrationId`);
  }
  emitStep(
    emit,
    migration.id,
    `Reconnecting to in-flight migration ${migration.githubMigrationId}`,
  );
  try {
    const requestOptions = migration.requestOptions
      ? tryParsePersistedRequestOptions(migration.requestOptions)
      : null;
    const clients = dependencies.createClients({
      sourceApiUrl: migration.sourceApiUrl,
      noSslVerify: requestOptions?.noSslVerify,
      sourceAuth: dependencies.resolveSourceAuth(),
      targetApiUrl: migration.targetApiUrl,
      targetAuth: dependencies.resolveTargetAuth(),
    });
    const result = await dependencies.monitorGhecMigration(
      clients,
      migration,
      migration.githubMigrationId,
      emit,
      signal,
    );
    if (result.state === "succeeded" && requestOptions?.archiveSource) {
      emitStep(
        emit,
        migration.id,
        "Source archive was not attempted after recovery; archive the source repository manually if required",
        { operation: "source_archive", outcome: "not_attempted" },
      );
    }
    return result;
  } catch {
    if (signal?.aborted) {
      await cancelRemoteMigration(
        {
          sourceProvider: "github",
          sourceApiUrl: migration.sourceApiUrl,
          sourceRepo: `${migration.sourceOrg}/${migration.sourceRepo}`,
          targetProfileId: migration.targetProfileId,
          targetOrg: migration.targetOrg,
          targetRepo: migration.targetRepo,
          emit,
        },
        migration,
      );
    } else {
      migration.state = "reconciliation_required";
    }
    completeFailure(
      migration,
      migration.state === "cancelled"
        ? "Migration cancelled"
        : "GHEC import outcome is unknown; check the target before restarting",
    );
    return migration;
  }
}
