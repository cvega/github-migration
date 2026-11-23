import type { Migration } from "$lib/migrate/types";
import {
  type GhesTargetConnectionConfig,
  getBitbucketGhesTargetExecutionConfig,
} from "$lib/server/core/ghes-target";
import { getBitbucketMigrationSourceConfig } from "$lib/server/migrate/ports/source-runtime";
import { BitbucketExporterWorker } from "../exporters/bitbucket";
import type { ExporterWorker } from "../exporters/worker";
import { bitbucketArchiveRecords } from "../ghes/archive-records";
import {
  defaultGhesWait,
  type ExporterGhesSourceAdapter,
  type GhesImportClient,
  type GhesMigrationOptions,
  resumeExporterGhesMigration,
  runExporterGhesMigration,
} from "../ghes/import";
import { GhesSshClient } from "../ghes/ssh";

interface BitbucketGhesDependencies {
  getConfig: typeof getBitbucketGhesTargetExecutionConfig;
  getSourceConfig: typeof getBitbucketMigrationSourceConfig;
  createWorker(config: ReturnType<typeof getBitbucketGhesTargetExecutionConfig>): ExporterWorker;
  createSshClient(config: GhesTargetConnectionConfig): GhesImportClient;
  wait: typeof defaultGhesWait;
}
const defaults: BitbucketGhesDependencies = {
  getConfig: getBitbucketGhesTargetExecutionConfig,
  getSourceConfig: getBitbucketMigrationSourceConfig,
  createWorker: (config) => new BitbucketExporterWorker(config),
  createSshClient: (config) => new GhesSshClient(config),
  wait: defaultGhesWait,
};
let dependencies = { ...defaults };
export function __setBitbucketToGhesDependenciesForTests(
  overrides: Partial<BitbucketGhesDependencies>,
): () => void {
  dependencies = { ...defaults, ...overrides };
  return () => {
    dependencies = { ...defaults };
  };
}
function adapter(): ExporterGhesSourceAdapter {
  const source = dependencies.getSourceConfig();
  return {
    provider: "bitbucket-server",
    displayName: "Bitbucket Server",
    getConfig: dependencies.getConfig,
    assertSource(migration) {
      if (!source.authAvailable || source.apiUrl !== migration.sourceApiUrl) {
        throw new Error("Configured Bitbucket source changed after submission");
      }
    },
    createWorker: (config) =>
      dependencies.createWorker(config as ReturnType<typeof getBitbucketGhesTargetExecutionConfig>),
    createSshClient: dependencies.createSshClient,
    sourceWasLocked: async () => true,
    localMappingRecords: bitbucketArchiveRecords,
    wait: dependencies.wait,
  };
}
export function runBitbucketToGhesMigration(options: GhesMigrationOptions): Promise<Migration> {
  return runExporterGhesMigration(options, adapter());
}
export function resumeBitbucketToGhesMigration(
  migration: Migration,
  emit: GhesMigrationOptions["emit"],
  signal?: AbortSignal,
): Promise<Migration> {
  return resumeExporterGhesMigration(migration, emit, signal, adapter());
}
