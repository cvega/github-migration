import type { Migration, MigrationState } from "$lib/migrate/types";
import { isTerminalMigrationState } from "$lib/migration-state";
import {
  getMigration,
  hasUnresolvedRemoteWork,
  updateMigrationState,
} from "../database/migrations";
import { activeMigrationRuns } from "./active";
import { broadcastMigrationEvent, closeMigrationEventStream, insertLifecycleStep } from "./events";

export interface MigrationRunFinisher {
  settleResult(id: string, runToken: symbol, result: Migration): void;
  settleError(id: string, runToken: symbol, error: unknown): void;
}

export function createMigrationRunFinisher(drainQueue: () => void): MigrationRunFinisher {
  function finish(id: string, runToken: symbol, closeState?: MigrationState): void {
    if (closeState === "cancelled" || closeState === "reconciliation_required") {
      const message =
        closeState === "cancelled"
          ? "Migration cancelled"
          : "Remote migration status requires review before restart";
      broadcastMigrationEvent(id, insertLifecycleStep(id, message));
    }
    if (closeState) closeMigrationEventStream(id, closeState);
    activeMigrationRuns.finish(id, runToken);
    drainQueue();
  }

  function settleResult(id: string, runToken: symbol, result: Migration): void {
    if (!activeMigrationRuns.owns(id, runToken)) return;

    const current = getMigration(id);
    if (current?.state === "cancelling") {
      const state = result.state === "cancelled" ? "cancelled" : "reconciliation_required";
      updateMigrationState(id, state, {
        failureReason:
          state === "reconciliation_required"
            ? "Migration settled remotely while cancellation was pending"
            : undefined,
        completedAt: result.completedAt ?? new Date().toISOString(),
      });
      finish(id, runToken, state);
      return;
    }
    if (current && isTerminalMigrationState(current.state)) {
      if (
        current.state === "succeeded" &&
        result.state === "succeeded" &&
        !current.targetCounts &&
        result.targetCounts
      ) {
        updateMigrationState(id, current.state, { targetCounts: result.targetCounts });
      }
      finish(id, runToken, current.state);
      return;
    }

    const settled = updateMigrationState(
      id,
      result.state,
      {
        githubMigrationId: result.githubMigrationId ?? undefined,
        sourceCounts: result.sourceCounts ?? undefined,
        targetCounts: result.state === "succeeded" ? result.targetCounts : undefined,
        warningsCount: result.warningsCount || undefined,
        completedAt: result.completedAt ?? undefined,
        elapsedSeconds: result.elapsedSeconds ?? undefined,
        failureReason: result.failureReason ?? undefined,
        migrationLogUrl: result.migrationLogUrl ?? undefined,
      },
      true,
    );
    let finalState = result.state;
    if (!settled && getMigration(id)?.state === "cancelling") {
      finalState = result.state === "cancelled" ? "cancelled" : "reconciliation_required";
      updateMigrationState(id, finalState, {
        failureReason:
          result.state === "cancelled"
            ? undefined
            : "Migration settled remotely while cancellation was pending",
        completedAt: result.completedAt ?? new Date().toISOString(),
      });
    }
    finish(id, runToken, isTerminalMigrationState(finalState) ? finalState : undefined);
  }

  function settleError(id: string, runToken: symbol): void {
    if (!activeMigrationRuns.owns(id, runToken)) return;

    const state = hasUnresolvedRemoteWork(id) ? "reconciliation_required" : "failed";
    // Provider errors can retain GraphQL variables, headers and signed URLs.
    const failureReason =
      "Unexpected executor failure; check the source and target before restarting";
    console.error(`[migrate] ${id}: ${failureReason}`);
    const settled = updateMigrationState(
      id,
      state,
      { failureReason, completedAt: new Date().toISOString() },
      true,
    );
    const finalState =
      !settled && getMigration(id)?.state === "cancelling" ? "reconciliation_required" : state;
    if (!settled && finalState === "reconciliation_required") {
      updateMigrationState(id, finalState, {
        failureReason,
        completedAt: new Date().toISOString(),
      });
    }
    finish(id, runToken, finalState);
  }

  return { settleResult, settleError };
}
