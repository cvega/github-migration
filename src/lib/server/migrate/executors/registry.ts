import type { CreateMigrationRequest, Migration } from "$lib/migrate/types";
import { getMigrationExecutor, type MigrationExecutor } from "$lib/source-provider";
import type { MigrationEventEmitter } from "../github/monitor";
import { resumeBitbucketToGhecMigration, runBitbucketToGhecMigration } from "./bitbucket-to-ghec";
import { resumeBitbucketToGhesMigration, runBitbucketToGhesMigration } from "./bitbucket-to-ghes";
import { resumeGitHubToGhecMigration, runGitHubToGhecMigration } from "./github-to-ghec";
import { resumeGitLabToGhecMigration, runGitLabToGhecMigration } from "./gitlab-to-ghec";
import { resumeGitLabToGhesMigration, runGitLabToGhesMigration } from "./gitlab-to-ghes";

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
  "gitlab-ghes": {
    run: runGitLabToGhesMigration,
    resume: resumeGitLabToGhesMigration,
  },
  "bitbucket-server-ghes": {
    run: runBitbucketToGhesMigration,
    resume: resumeBitbucketToGhesMigration,
  },
} satisfies Partial<Record<MigrationExecutor, RegisteredMigrationExecutor>>;

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
  const executor = executors[executorId as keyof typeof executors];
  if (!executor) throw new Error(`Migration executor '${executorId}' is not implemented`);
  return executor;
}

export function getExecutorForMigration(migration: Migration): RegisteredMigrationExecutor {
  return getRegisteredMigrationExecutor({
    sourceProvider: migration.sourceProvider,
    targetPlatform: migration.targetPlatform,
  });
}
