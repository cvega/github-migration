import type { Counts, MigrationEvent, MigrationState } from "$lib/migrate/types";
import { isTerminalMigrationState } from "$lib/migration-state";
import { getDb } from "$lib/server/core/db";
import { insertEvent } from "../database/events";
import { getMigration, updateMigrationState } from "../database/migrations";
import { activeMigrationRuns } from "./active";

const migrationSubscribers = new Map<string, Set<ReadableStreamDefaultController<string>>>();
const globalSubscribers = new Set<ReadableStreamDefaultController<string>>();

export function subscribeToMigrationEvents(
  migrationId: string,
  controller: ReadableStreamDefaultController<string>,
): () => void {
  let subscribers = migrationSubscribers.get(migrationId);
  if (!subscribers) {
    subscribers = new Set();
    migrationSubscribers.set(migrationId, subscribers);
  }
  subscribers.add(controller);
  return () => {
    migrationSubscribers.get(migrationId)?.delete(controller);
    if (migrationSubscribers.get(migrationId)?.size === 0) {
      migrationSubscribers.delete(migrationId);
    }
  };
}

export function subscribeToGlobalMigrationEvents(
  controller: ReadableStreamDefaultController<string>,
): () => void {
  globalSubscribers.add(controller);
  return () => globalSubscribers.delete(controller);
}

export function broadcastMigrationEvent(migrationId: string, event: MigrationEvent): void {
  const idLine = event.id != null ? `id: ${event.id}\n` : "";
  const data = `${idLine}data: ${JSON.stringify(event)}\n\n`;
  const subscribers = migrationSubscribers.get(migrationId);
  if (subscribers) {
    for (const controller of subscribers) {
      try {
        controller.enqueue(data);
      } catch {
        subscribers.delete(controller);
      }
    }
  }
  for (const controller of globalSubscribers) {
    try {
      controller.enqueue(data);
    } catch {
      globalSubscribers.delete(controller);
    }
  }
}

export function closeMigrationEventStream(migrationId: string, state: MigrationState): void {
  const subscribers = migrationSubscribers.get(migrationId);
  if (!subscribers) return;
  const data = `data: ${JSON.stringify({ type: "done", state })}\n\n`;
  for (const controller of subscribers) {
    try {
      controller.enqueue(data);
      controller.close();
    } catch {
      // The client already disconnected.
    }
  }
  migrationSubscribers.delete(migrationId);
}

export function createMigrationEventHandler(
  id: string,
  runToken: symbol,
): (event: MigrationEvent) => void {
  return (event: MigrationEvent) => {
    if (!activeMigrationRuns.owns(id, runToken)) return;

    const current = getMigration(id);
    const postSuccessArchive =
      event.eventType === "step" && event.payload.postTerminal?.operation === "source_archive";
    if (
      current &&
      isTerminalMigrationState(current.state) &&
      !(current.state === "succeeded" && postSuccessArchive)
    ) {
      return;
    }

    getDb().transaction(() => {
      event.id = insertEvent(event);
      const persisted = getMigration(id);
      if (
        persisted?.state === "cancelling" &&
        (event.eventType === "complete" || event.eventType === "failure")
      ) {
        updateMigrationState(id, "reconciliation_required", {
          failureReason: "Migration settled remotely while cancellation was pending",
          completedAt: new Date().toISOString(),
        });
        return;
      }

      if (event.eventType === "complete") {
        const snapshot = event.payload.progress.current;
        const extra: Parameters<typeof updateMigrationState>[2] = {
          completedAt: new Date().toISOString(),
          elapsedSeconds: event.payload.elapsed,
          sourceCounts: event.payload.sourceCounts ?? undefined,
          warningsCount: snapshot.warningsCount,
          migrationLogUrl: snapshot.migrationLogUrl || undefined,
          targetCounts: null,
        };
        if (snapshot.countsAuthoritative) {
          extra.targetCounts = {
            commits: snapshot.commits,
            branches: snapshot.branches,
            tags: snapshot.tags,
            issues: snapshot.issues,
            pullRequests: snapshot.pullRequests,
            releases: snapshot.releases,
          };
        }
        updateMigrationState(id, "succeeded", extra);
      } else if (event.eventType === "failure") {
        updateMigrationState(id, "failed", {
          failureReason:
            event.payload.detail?.failureReason || event.payload.error || "Unknown error",
          completedAt: new Date().toISOString(),
        });
      } else if (event.eventType === "step") {
        const migration = getMigration(id);
        if (migration?.state === "cancelling") return;
        const newState =
          migration?.state === "pending" ? "running" : (migration?.state ?? "running");
        const extra: Parameters<typeof updateMigrationState>[2] = {};
        if (event.payload.counts) extra.sourceCounts = event.payload.counts;
        if (newState !== migration?.state || Object.keys(extra).length > 0) {
          updateMigrationState(id, newState as MigrationState, extra);
        }
      } else if (event.eventType === "snapshot") {
        const migration = getMigration(id);
        if (
          !migration ||
          (migration.state !== "cancelling" && !isTerminalMigrationState(migration.state))
        ) {
          const snapshot = event.payload.progress.current;
          const extra: Parameters<typeof updateMigrationState>[2] = {};
          if (snapshot.warningsCount > 0) extra.warningsCount = snapshot.warningsCount;
          if (snapshot.migrationLogUrl) extra.migrationLogUrl = snapshot.migrationLogUrl;
          if (snapshot.countsAuthoritative) {
            const targetCounts: Counts = {
              commits: snapshot.commits,
              branches: snapshot.branches,
              tags: snapshot.tags,
              issues: snapshot.issues,
              pullRequests: snapshot.pullRequests,
              releases: snapshot.releases,
            };
            extra.targetCounts = targetCounts;
          }
          if (event.payload.sourceCounts) extra.sourceCounts = event.payload.sourceCounts;
          updateMigrationState(id, "running", extra);
        }
      }
    })();

    broadcastMigrationEvent(id, event);
  };
}
