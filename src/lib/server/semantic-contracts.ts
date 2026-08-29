import { MIGRATION_PHASES } from "$lib/migrate/types";
import { ALL_MIGRATION_STATES } from "$lib/migration-state";
import {
  getTargetPlatformPresentation,
  supportsMigrationTarget,
  TARGET_PLATFORMS,
  type TargetPlatform,
} from "$lib/migration-target";
import { AUTH_DURABLE_TABLES } from "$lib/server/core/auth/schema";
import type { DurableTableContract } from "$lib/server/core/db";
import { MIGRATE_DURABLE_TABLES } from "$lib/server/migrate/database/schema";
import { GHES_IMPORT_JOB_PHASES } from "$lib/server/migrate/ghes/job";
import { PROFILE_DURABLE_TABLES } from "$lib/server/profile/database/schema";
import {
  getMigrationExecutor,
  getSourceProviderAdapter,
  type MigrationExecutor,
  SOURCE_PROVIDERS,
  type SourceProvider,
} from "$lib/source-provider";

interface MigrationRouteContract {
  sourceProvider: SourceProvider;
  sourceDisplayName: string;
  targetPlatform: TargetPlatform;
  targetDisplayName: string;
  executor: MigrationExecutor | null;
}

export interface SemanticContracts {
  routes: readonly MigrationRouteContract[];
  migrationStates: readonly string[];
  migrationPhases: readonly string[];
  ghesImportPhases: readonly string[];
  durableTables: readonly DurableTableContract[];
}

function migrationRoutes(): MigrationRouteContract[] {
  return SOURCE_PROVIDERS.flatMap((sourceProvider) =>
    TARGET_PLATFORMS.map((targetPlatform) => {
      const executor = getMigrationExecutor(sourceProvider, targetPlatform);
      if (supportsMigrationTarget(sourceProvider, targetPlatform) !== (executor !== null)) {
        throw new Error(
          `Migration support and executor registry disagree for ${sourceProvider}->${targetPlatform}`,
        );
      }
      return {
        sourceProvider,
        sourceDisplayName: getSourceProviderAdapter(sourceProvider).displayName,
        targetPlatform,
        targetDisplayName: getTargetPlatformPresentation(targetPlatform).displayName,
        executor,
      };
    }),
  );
}

export const SEMANTIC_CONTRACTS: SemanticContracts = {
  routes: migrationRoutes(),
  migrationStates: ALL_MIGRATION_STATES,
  migrationPhases: MIGRATION_PHASES,
  ghesImportPhases: GHES_IMPORT_JOB_PHASES,
  durableTables: [...AUTH_DURABLE_TABLES, ...MIGRATE_DURABLE_TABLES, ...PROFILE_DURABLE_TABLES],
};
