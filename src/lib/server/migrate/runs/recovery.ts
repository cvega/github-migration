import type { CreateMigrationRequest, Migration } from "$lib/migrate/types";
import { getDb } from "$lib/server/core/db";
import { getMigrationExecutor } from "$lib/source-provider";
import {
  getQueuedEnvMigrations,
  getRecoverableMigrations,
  updateMigrationState,
} from "../database/migrations";
import { recoverInterruptedMigrations } from "../database/schema";
import {
  migrationTlsPolicyError,
  requestForMigration,
  safeParsePersistedRequestOptions,
  validatePersistedServerCredentialScope,
} from "../validate";
import { activeMigrationRuns } from "./active";
import { recordExistingGhesQueueHold } from "./queue";
import { auditSourceTlsOverride } from "./source-tls-audit";

export interface MigrationRecoveryDependencies {
  launchRecoveredPipeline(migration: Migration): boolean;
  drainQueue(): void;
  hasExecutor(migration: Migration): boolean;
  validateScope(request: CreateMigrationRequest): string | null;
}

function defaults(
  dependencies: Pick<MigrationRecoveryDependencies, "launchRecoveredPipeline" | "drainQueue">,
): MigrationRecoveryDependencies {
  return {
    ...dependencies,
    hasExecutor: (migration) =>
      getMigrationExecutor(migration.sourceProvider, migration.targetPlatform) !== null,
    validateScope: validatePersistedServerCredentialScope,
  };
}

export function recoverMigrationRuns(
  overrides: Pick<MigrationRecoveryDependencies, "launchRecoveredPipeline" | "drainQueue"> &
    Partial<Pick<MigrationRecoveryDependencies, "hasExecutor" | "validateScope">>,
): void {
  const dependencies = { ...defaults(overrides), ...overrides };
  function recoveryError(migration: Migration, request: CreateMigrationRequest): string | null {
    const scopeError = dependencies.validateScope(request);
    if (scopeError) return scopeError;
    const tlsError = migrationTlsPolicyError(request);
    if (tlsError) auditSourceTlsOverride(migration, "recovery", "denied", undefined);
    return tlsError;
  }

  recoverInterruptedMigrations(getDb());

  for (const migration of getRecoverableMigrations()) {
    if (!dependencies.hasExecutor(migration)) {
      updateMigrationState(migration.id, "reconciliation_required", {
        failureReason:
          "No executor is available for this route. Confirm the remote migration is inactive before completing review.",
        completedAt: new Date().toISOString(),
      });
      continue;
    }
    const request = requestForMigration(
      migration,
      safeParsePersistedRequestOptions(migration.requestOptions) ?? {},
    );
    const scopeError = recoveryError(migration, request);
    if (scopeError) {
      updateMigrationState(migration.id, "reconciliation_required", {
        failureReason: scopeError,
        completedAt: new Date().toISOString(),
      });
      continue;
    }
    dependencies.launchRecoveredPipeline(migration);
  }

  for (const migration of getQueuedEnvMigrations()) {
    if (!dependencies.hasExecutor(migration)) {
      updateMigrationState(migration.id, "failed", {
        failureReason: `${migration.sourceProvider} migration execution is not supported`,
        completedAt: new Date().toISOString(),
      });
      continue;
    }
    const options = safeParsePersistedRequestOptions(migration.requestOptions);
    if (!options) {
      updateMigrationState(migration.id, "failed", {
        failureReason: "Queued migration request options lost (internal error)",
        completedAt: new Date().toISOString(),
      });
      continue;
    }
    const request = requestForMigration(migration, options);
    const scopeError = recoveryError(migration, request);
    if (scopeError) {
      updateMigrationState(migration.id, "failed", {
        failureReason: scopeError,
        completedAt: new Date().toISOString(),
      });
      continue;
    }
    activeMigrationRuns.enqueue(migration.id, request);
  }

  recordExistingGhesQueueHold();
  dependencies.drainQueue();
}
