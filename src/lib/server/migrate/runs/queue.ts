import type {
  CreateMigrationRequest,
  Migration,
  MigrationEvent,
  MigrationState,
} from "$lib/migrate/types";
import { isTerminalMigrationState } from "$lib/migration-state";
import { getDb } from "$lib/server/core/db";
import { hasStepSinceRestart, insertEvent, insertQueuedGhesWaitSteps } from "../database/events";
import {
  getNextQueuedMigration,
  hasUnreconciledGhesImport,
  isBatchAdmissionBlocked,
  isGhesSlotHeld,
  updateMigrationState,
} from "../database/migrations";
import { getActiveMigrationCount } from "../database/stats";
import { activeMigrationRuns } from "./active";
import { broadcastMigrationEvent, closeMigrationEventStream, insertLifecycleStep } from "./events";

export const MAX_CONCURRENT_MIGRATIONS = 10;

export type PipelineLauncher = (id: string, request: CreateMigrationRequest) => boolean;

// Slot accounting needs only execution state and destination. An unreadable
// counts snapshot must not stop other jobs while an owned run is settling.
function registeredRunStates() {
  const ids = [...activeMigrationRuns.activeIds()];
  if (ids.length === 0) return [];
  return getDb()
    .query<{ state: MigrationState; appliance: number }, [string]>(
      `SELECT state, (target_platform != 'ghec' OR EXISTS (
       SELECT 1 FROM ghes_import_jobs WHERE migration_id = migrations.id)) AS appliance
     FROM migrations WHERE id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(ids));
}

// The configured GHES appliance has one ghe-migrator lock, shared across batches.
function ghesBusy(): boolean {
  return isGhesSlotHeld() || registeredRunStates().some((row) => row.appliance === 1);
}

export function shouldQueueMigration(migration: Migration): boolean {
  return (
    getCapacityUsage() >= MAX_CONCURRENT_MIGRATIONS ||
    (migration.targetPlatform === "ghes" && ghesBusy()) ||
    isBatchAdmissionBlocked(migration)
  );
}

const WAITING_FOR_REVIEW = "GHES migration queued pending administrator review.";

export function recordGhesQueueHold(migration: Migration): void {
  if (migration.targetPlatform === "ghes" && hasUnreconciledGhesImport())
    insertLifecycleStep(migration.id, WAITING_FOR_REVIEW);
}

export function recordExistingGhesQueueHold(blockerId?: string): void {
  if (hasUnreconciledGhesImport(blockerId)) insertQueuedGhesWaitSteps(WAITING_FOR_REVIEW);
}

export function getCapacityUsage(): number {
  const settling = registeredRunStates().filter((row) =>
    isTerminalMigrationState(row.state),
  ).length;
  return getActiveMigrationCount() + settling;
}

// Fresh attempts only. The executor runs asynchronously after registration.
export function launchClaimedMigration(
  id: string,
  request: CreateMigrationRequest,
  launchPipeline: PipelineLauncher,
): boolean {
  try {
    if (launchPipeline(id, request)) return true;
  } catch {
    // Launcher errors may contain request data.
  }
  console.error(`[manager] Could not launch claimed migration ${id}`);
  // A refused registration can mean an existing run still owns the row.
  if (!activeMigrationRuns.isActive(id)) {
    const failureReason = "Migration could not be launched";
    const event: MigrationEvent = {
      migrationId: id,
      eventType: "failure",
      phase: "FAILED",
      payload: { error: failureReason },
      createdAt: new Date().toISOString(),
    };
    const recorded = getDb().transaction(() => {
      if (!updateMigrationState(id, "failed", { failureReason, completedAt: event.createdAt }))
        return false;
      event.id = insertEvent(event);
      return true;
    })();
    if (recorded) {
      broadcastMigrationEvent(id, event);
      closeMigrationEventStream(id, "failed");
    }
  }
  return false;
}

export function drainMigrationQueue(launchPipeline: PipelineLauncher): void {
  while (true) {
    const claimed = getDb().transaction(() => {
      if (getCapacityUsage() >= MAX_CONCURRENT_MIGRATIONS) return null;
      const candidate = getNextQueuedMigration(ghesBusy());
      if (candidate?.migration) updateMigrationState(candidate.id, "pending");
      return candidate;
    })();

    if (!claimed) break;
    if (!claimed.migration) {
      activeMigrationRuns.dropQueued(claimed.id);
      continue;
    }
    const request = activeMigrationRuns.takeQueued(claimed.id);
    if (!request) {
      console.error(`[manager] No queued request for migration ${claimed.id} - marking failed`);
      updateMigrationState(claimed.id, "failed", {
        failureReason: "Queued migration request lost (internal error)",
        completedAt: new Date().toISOString(),
      });
      continue;
    }
    if (
      launchClaimedMigration(claimed.id, request, launchPipeline) &&
      claimed.migration.targetPlatform === "ghes" &&
      hasStepSinceRestart(claimed.id, WAITING_FOR_REVIEW)
    ) {
      broadcastMigrationEvent(
        claimed.id,
        insertLifecycleStep(claimed.id, "GHES migration launched after administrator review."),
      );
    }
  }
}
