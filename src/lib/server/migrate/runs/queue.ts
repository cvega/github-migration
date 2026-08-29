import type { CreateMigrationRequest } from "$lib/migrate/types";
import { isTerminalMigrationState } from "$lib/migration-state";
import { getDb } from "$lib/server/core/db";
import { getMigration, getNextQueuedMigration, updateMigrationState } from "../database/migrations";
import { getActiveMigrationCount } from "../database/stats";
import { activeMigrationRuns } from "./active";

export const MAX_CONCURRENT_MIGRATIONS = 10;

export type PipelineLauncher = (id: string, request: CreateMigrationRequest) => boolean;

export function getCapacityUsage(): number {
  let settling = 0;
  for (const id of activeMigrationRuns.activeIds()) {
    const migration = getMigration(id);
    if (migration && isTerminalMigrationState(migration.state)) settling += 1;
  }
  return getActiveMigrationCount() + settling;
}

export function drainMigrationQueue(launchPipeline: PipelineLauncher): void {
  for (const _slot of Array(MAX_CONCURRENT_MIGRATIONS)) {
    const claimed = getDb().transaction(() => {
      if (getCapacityUsage() >= MAX_CONCURRENT_MIGRATIONS) return null;
      const queued = getNextQueuedMigration();
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
    launchPipeline(claimed.id, request);
  }
}
