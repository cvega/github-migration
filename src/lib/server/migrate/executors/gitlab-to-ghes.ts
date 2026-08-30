import type { Migration } from "$lib/migrate/types";
import {
  type GhesTargetConnectionConfig,
  getGhesTargetExecutionConfig,
} from "$lib/server/core/ghes-target";
import {
  type GitLabGhesSourceClient,
  getGitLabGhesSourceClient,
} from "$lib/server/migrate/ports/source-runtime";
import { GitLabExporterWorker } from "../exporters/gitlab";
import type { ExporterWorker } from "../exporters/worker";
import {
  defaultGhesWait,
  type ExporterGhesSourceAdapter,
  type GhesImportClient,
  type GhesMigrationOptions,
  resumeExporterGhesMigration,
  runExporterGhesMigration,
} from "../ghes/import";
import { GhesSshClient } from "../ghes/ssh";

interface GitLabGhesDependencies {
  getConfig: typeof getGhesTargetExecutionConfig;
  getSourceClient(): GitLabGhesSourceClient;
  createWorker(config: ReturnType<typeof getGhesTargetExecutionConfig>): ExporterWorker;
  createSshClient(config: GhesTargetConnectionConfig): GhesImportClient;
  wait: typeof defaultGhesWait;
}
const defaults: GitLabGhesDependencies = {
  getConfig: getGhesTargetExecutionConfig,
  getSourceClient: getGitLabGhesSourceClient,
  createWorker: (config) => new GitLabExporterWorker(config),
  createSshClient: (config) => new GhesSshClient(config),
  wait: defaultGhesWait,
};
let dependencies = { ...defaults };
export function __setGitLabToGhesDependenciesForTests(
  overrides: Partial<GitLabGhesDependencies>,
): () => void {
  dependencies = { ...defaults, ...overrides };
  return () => {
    dependencies = { ...defaults };
  };
}
function path(migration: Migration): string {
  return `${migration.sourceOrg}/${migration.sourceRepo}`;
}
function adapter(): ExporterGhesSourceAdapter {
  const client = dependencies.getSourceClient();
  return {
    provider: "gitlab",
    displayName: "GitLab",
    getConfig: dependencies.getConfig,
    assertSource(migration) {
      if (client.apiUrl !== migration.sourceApiUrl)
        throw new Error("Configured GitLab source URL changed after submission");
    },
    createWorker: (config) =>
      dependencies.createWorker(config as ReturnType<typeof getGhesTargetExecutionConfig>),
    createSshClient: dependencies.createSshClient,
    sourceWasLocked: (migration, signal) => client.isProjectArchived(path(migration), signal),
    unlockSource: (migration) => client.unarchiveProject(path(migration)),
    wait: dependencies.wait,
  };
}
export function runGitLabToGhesMigration(options: GhesMigrationOptions): Promise<Migration> {
  return runExporterGhesMigration(options, adapter());
}
export function resumeGitLabToGhesMigration(
  migration: Migration,
  emit: GhesMigrationOptions["emit"],
  signal?: AbortSignal,
): Promise<Migration> {
  return resumeExporterGhesMigration(migration, emit, signal, adapter());
}
