import type { CreateMigrationRequest, Migration } from "$lib/migrate/types";
import { GITLAB_GHES_PAUSE_REASON, isPausedPersistedRoute } from "$lib/migration-target";
import { getMigrationExecutor, type MigrationExecutor } from "$lib/source-provider";
import type { MigrationEventEmitter } from "../github/monitor";
import { resumeBitbucketToGhecMigration, runBitbucketToGhecMigration } from "./bitbucket-to-ghec";
import { resumeBitbucketToGhesMigration, runBitbucketToGhesMigration } from "./bitbucket-to-ghes";
import { resumeGitHubToGhecMigration, runGitHubToGhecMigration } from "./github-to-ghec";
import { resumeGitLabToGhecMigration, runGitLabToGhecMigration } from "./gitlab-to-ghec";

interface MigrationExecutionOptions extends CreateMigrationRequest {
  id?: string;
  signal?: AbortSignal;
  emit: MigrationEventEmitter;
}

interface RegisteredMigrationExecutor {
  run(options: MigrationExecutionOptions): Promise<Migration>;
  resume(
    migration: Migration,
    emit: MigrationEventEmitter,
    signal?: AbortSignal,
  ): Promise<Migration>;
}

const executors = {
  "github-api": {
    run: runGitHubToGhecMigration,
    resume: resumeGitHubToGhecMigration,
  },
  "gitlab-native": {
    run: runGitLabToGhecMigration,
    resume: resumeGitLabToGhecMigration,
  },
  "bitbucket-server-native": {
    run: runBitbucketToGhecMigration,
    resume: resumeBitbucketToGhecMigration,
  },
  "bitbucket-server-ghes": {
    run: runBitbucketToGhesMigration,
    resume: resumeBitbucketToGhesMigration,
  },
} satisfies Record<MigrationExecutor, RegisteredMigrationExecutor>;

export function getRegisteredMigrationExecutor(
  request: Pick<CreateMigrationRequest, "sourceProvider"> & {
    targetPlatform?: Migration["targetPlatform"];
  },
): RegisteredMigrationExecutor {
  const sourceProvider = request.sourceProvider ?? "github";
  const executorId = getMigrationExecutor(sourceProvider, request.targetPlatform ?? "ghec");
  if (!executorId) {
    throw new TypeError(`${sourceProvider} cannot migrate to ${request.targetPlatform ?? "ghec"}`);
  }
  return executors[executorId];
}

export function getExecutorForMigration(migration: Migration): RegisteredMigrationExecutor {
  if (isPausedPersistedRoute(migration)) throw new TypeError(GITLAB_GHES_PAUSE_REASON);
  return getRegisteredMigrationExecutor({
    sourceProvider: migration.sourceProvider,
    targetPlatform: migration.targetPlatform,
  });
}
