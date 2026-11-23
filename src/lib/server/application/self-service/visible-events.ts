import type { MigrationEvent, Snapshot } from "$lib/migrate/types";
import { MIGRATION_PHASES } from "$lib/migrate/types";
import { getMigrationEventReplayWindow } from "$lib/server/migrate/database/events";
import { getVisibleJob } from "./visible-jobs";

function snapshot(value: Snapshot): Snapshot {
  return { ...value, failureReason: "", migrationLogUrl: "", migrationState: value.phase };
}

// Preserve the progress rail and quantitative snapshots without exposing arbitrary
// provider text, credentials in errors, or pre-signed artifact URLs.
function present(event: MigrationEvent): MigrationEvent {
  const common = {
    id: event.id,
    createdAt: event.createdAt,
    migrationId: event.migrationId,
    phase: event.phase && MIGRATION_PHASES.includes(event.phase) ? event.phase : null,
  };
  switch (event.eventType) {
    case "snapshot":
    case "complete": {
      const { progress } = event.payload;
      const payload = {
        sourceCounts: event.payload.sourceCounts,
        progress: {
          ...progress,
          current: snapshot(progress.current),
          previous: progress.previous && snapshot(progress.previous),
        },
      };
      return event.eventType === "complete"
        ? {
            ...common,
            eventType: "complete",
            payload: { ...payload, elapsed: event.payload.elapsed },
          }
        : { ...common, eventType: "snapshot", payload };
    }
    case "phase_change":
      return { ...common, eventType: "phase_change", payload: event.payload };
    case "failure":
      return { ...common, eventType: "failure", payload: {} };
    case "step": {
      const phase = event.payload.executorPhase;
      const known =
        phase &&
        ["archive_ready", "transferring", "preparing", "mapping", "auditing", "unlocking"].includes(
          phase,
        );
      return {
        ...common,
        eventType: "step",
        payload: known
          ? { executorPhase: phase, message: phase.replace("_", " ") }
          : { message: "Migration step recorded" },
      };
    }
    case "restart":
      return { ...common, eventType: "restart", payload: { message: "Migration restarted" } };
    case "banner":
      return { ...common, eventType: "banner", payload: { message: "Migration update" } };
    case "milestone":
      return {
        ...common,
        eventType: "milestone",
        payload: { message: "Migration milestone reached" },
      };
  }
}

export function getVisibleDetail(userId: string, id: string) {
  const migration = getVisibleJob(userId, id);
  if (!migration) return null;
  const { events, highWater } = getMigrationEventReplayWindow(id, 0);
  return { migration, events: events.map(present), eventCursor: highWater };
}
