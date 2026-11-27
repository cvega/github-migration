import type { CreateMigrationRequest, Migration, MigrationEvent } from "$lib/migrate/types";
import { isTerminalMigrationState } from "$lib/migration-state";
import { getDb } from "$lib/server/core/db";
import { insertEvent } from "../database/events";
import {
  getMigration,
  getNextQueuedMigration,
  isBatchAdmissionBlocked,
  isGhesSlotHeld,
  updateMigrationState,
} from "../database/migrations";
import { getActiveMigrationCount } from "../database/stats";
import { activeMigrationRuns } from "./active";
import { broadcastMigrationEvent, closeMigrationEventStream } from "./events";

export const MAX_CONCURRENT_MIGRATIONS = 10;

export type PipelineLauncher = (id: string, request: CreateMigrationRequest) => boolean;

// The configured GHES appliance has one ghe-migrator lock, shared across batches.
function ghesBusy(): boolean {
  return (
    isGhesSlotHeld() ||
    [...activeMigrationRuns.activeIds()].some((id) => getMigration(id)?.targetPlatform === "ghes")
  );
}

export function shouldQueueMigration(migration: Migration): boolean {
  return (
    getCapacityUsage() >= MAX_CONCURRENT_MIGRATIONS ||
    (migration.targetPlatform === "ghes" && ghesBusy()) ||
    isBatchAdmissionBlocked(migration)
  );
}

export function getCapacityUsage(): number {
  let settling = 0;
  for (const id of activeMigrationRuns.activeIds()) {
    const migration = getMigration(id);
    if (migration && isTerminalMigrationState(migration.state)) settling += 1;
  }
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
      const queued = getNextQueuedMigration(ghesBusy());
      if (!queued) return null;
      updateMigrationState(queued.id, "pending");
      return queued;
    })();

    if (!claimed) break;
    const request = activeMigrationRuns.takeQueued(claimed.id);
    if (!request) {
      console.error(`[manager] No queued request for migration ${claimed.id} - marking failed`);
      updateMigrationState(claimed.id, "failed", {
        failureReason: "Queued migration request lost (internal error)",
        completedAt: new Date().toISOString(),
      });
      continue;
    }
    launchClaimedMigration(claimed.id, request, launchPipeline);
  }
}
