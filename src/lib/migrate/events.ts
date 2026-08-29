import type { Migration, MigrationEvent } from "$lib/migrate/types";

export function eventChangesBatchSummary(event: Pick<MigrationEvent, "eventType">): boolean {
  return event.eventType === "complete" || event.eventType === "failure";
}

export function patchMigrationFromEvent(migration: Migration, event: MigrationEvent): Migration {
  if (migration.id !== event.migrationId) return migration;

  if (event.eventType === "step") {
    return {
      ...migration,
      state: migration.state === "pending" ? "running" : migration.state,
      sourceCounts: event.payload.counts ?? migration.sourceCounts,
    };
  }

  if (event.eventType === "snapshot" || event.eventType === "complete") {
    const snapshot = event.payload.progress.current;
    return {
      ...migration,
      state: event.eventType === "complete" ? "succeeded" : migration.state,
      sourceCounts: event.payload.sourceCounts ?? migration.sourceCounts,
      targetCounts: {
        commits: snapshot.commits,
        branches: snapshot.branches,
        tags: snapshot.tags,
        issues: snapshot.issues,
        pullRequests: snapshot.pullRequests,
        releases: snapshot.releases,
      },
      warningsCount: snapshot.warningsCount,
      migrationLogUrl: snapshot.migrationLogUrl || migration.migrationLogUrl,
      completedAt: event.eventType === "complete" ? event.createdAt : migration.completedAt,
      elapsedSeconds:
        event.eventType === "complete" ? event.payload.elapsed : migration.elapsedSeconds,
    };
  }

  if (event.eventType === "failure") {
    return {
      ...migration,
      state: "failed",
      failureReason:
        event.payload.detail?.failureReason ?? event.payload.error ?? migration.failureReason,
      completedAt: event.createdAt,
    };
  }

  return migration;
}
