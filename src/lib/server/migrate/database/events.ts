import type { ActivityItem, ActivityKind, EventType, MigrationEvent } from "$lib/migrate/types";
import { getDb } from "$lib/server/core/db";
import { EXECUTABLE_PROVIDER_SQL, parsePersistedEventPayload } from "./migrations";

const EVENT_COLS = "id, migration_id, event_type, phase, payload, created_at";
const VALID_EVENT_TYPES = new Set<EventType>([
  "banner",
  "step",
  "phase_change",
  "milestone",
  "snapshot",
  "complete",
  "failure",
  "restart",
]);
const ACTIVITY_EVENT_TYPES = ["complete", "failure", "restart", "banner"] as const;

function readEventPayload(row: Record<string, unknown>): MigrationEvent["payload"] | null {
  try {
    return parsePersistedEventPayload(row.event_type as EventType, row.payload as string);
  } catch {
    // A malformed legacy row must not prevent reading the rest of the history.
    return null;
  }
}

function rowsToEvents(rows: Record<string, unknown>[]): MigrationEvent[] {
  const events: MigrationEvent[] = [];
  for (const row of rows) {
    if (!VALID_EVENT_TYPES.has(row.event_type as EventType)) continue;
    const payload = readEventPayload(row);
    if (!payload) continue;
    events.push({
      id: row.id as number,
      migrationId: row.migration_id as string,
      eventType: row.event_type,
      phase: row.phase ?? null,
      payload,
      createdAt: row.created_at as string,
    } as MigrationEvent);
  }
  return events;
}

export function insertEvent(event: MigrationEvent): number {
  const result = getDb()
    .prepare(
      `INSERT INTO events (migration_id, event_type, phase, payload, created_at)
			 SELECT $id, $event_type, $phase, $payload, $created_at
			 FROM migrations WHERE id = $id`,
    )
    .run({
      $id: event.migrationId,
      $event_type: event.eventType,
      $phase: event.phase,
      $payload: JSON.stringify(event.payload),
      $created_at: event.createdAt,
    });
  return Number(result.lastInsertRowid);
}

export function hasStepSinceRestart(migrationId: string, message: string): boolean {
  return !!getDb()
    .prepare(`SELECT 1 FROM events
    WHERE migration_id = $id AND event_type = 'step'
      AND id > (SELECT COALESCE(MAX(id), 0) FROM events WHERE migration_id = $id AND event_type = 'restart')
      AND CASE WHEN json_valid(payload) THEN json_extract(payload, '$.message') = $message END
    LIMIT 1`)
    .get({ $id: migrationId, $message: message });
}

export function getEvents(migrationId: string, afterId?: number): MigrationEvent[] {
  const rows =
    afterId !== undefined
      ? (getDb()
          .prepare(
            `SELECT ${EVENT_COLS} FROM events WHERE migration_id = ? AND id > ? ORDER BY id ASC`,
          )
          .all(migrationId, afterId) as Record<string, unknown>[])
      : (getDb()
          .prepare(`SELECT ${EVENT_COLS} FROM events WHERE migration_id = ? ORDER BY id ASC`)
          .all(migrationId) as Record<string, unknown>[]);
  return rowsToEvents(rows);
}

export const GLOBAL_EVENT_REPLAY_LIMIT = 1_000;

/** Page a finite snapshot without holding a SQLite read cursor during network writes. */
export function eventDownloadPages(migrationId: string) {
  const db = getDb();
  const { last } = db
    .query<{ last: number }, [string]>(
      "SELECT COALESCE(MAX(id), 0) AS last FROM events WHERE migration_id = ?",
    )
    .get(migrationId)!;
  return (function* () {
    let cursor = 0;
    const query = db.query<Record<string, unknown>, [string, number, number]>(
      `SELECT ${EVENT_COLS} FROM events WHERE migration_id = ? AND id > ? AND id <= ? ORDER BY id LIMIT 128`,
    );
    while (cursor < last) {
      const rows = query.all(migrationId, cursor, last);
      if (!rows.length) return;
      cursor = Number(rows.at(-1)?.id);
      yield rowsToEvents(rows);
    }
  })();
}

export interface EventReplayWindow {
  events: MigrationEvent[];
  highWater: number;
  stale: "replay_limit" | "cursor_ahead" | null;
  replayFrom: number | null;
}

function eventReplayWindow(migrationId: string | null, afterId: number): EventReplayWindow {
  return getDb().transaction(() => {
    const highWaterRow = (
      migrationId === null
        ? getDb().prepare("SELECT COALESCE(MAX(id), 0) AS id FROM events").get()
        : getDb()
            .prepare("SELECT COALESCE(MAX(id), 0) AS id FROM events WHERE migration_id = ?")
            .get(migrationId)
    ) as { id: number };
    const highWater = highWaterRow.id;
    const rows = (
      migrationId === null
        ? getDb()
            .prepare(
              `SELECT * FROM (
								SELECT ${EVENT_COLS} FROM events
								WHERE id > ? AND id <= ?
								ORDER BY id DESC LIMIT ?
							) ORDER BY id ASC`,
            )
            .all(afterId, highWater, GLOBAL_EVENT_REPLAY_LIMIT)
        : getDb()
            .prepare(
              `SELECT * FROM (
								SELECT ${EVENT_COLS} FROM events
								WHERE id > ? AND id <= ? AND migration_id = ?
								ORDER BY id DESC LIMIT ?
							) ORDER BY id ASC`,
            )
            .all(afterId, highWater, migrationId, GLOBAL_EVENT_REPLAY_LIMIT)
    ) as Record<string, unknown>[];
    const events = rowsToEvents(rows);
    const replayCountRow = (
      migrationId === null
        ? getDb()
            .prepare("SELECT COUNT(*) AS count FROM events WHERE id > ? AND id <= ?")
            .get(afterId, highWater)
        : getDb()
            .prepare(
              "SELECT COUNT(*) AS count FROM events WHERE id > ? AND id <= ? AND migration_id = ?",
            )
            .get(afterId, highWater, migrationId)
    ) as { count: number };
    const stale: EventReplayWindow["stale"] =
      afterId > highWater
        ? "cursor_ahead"
        : replayCountRow.count > GLOBAL_EVENT_REPLAY_LIMIT
          ? "replay_limit"
          : null;
    return {
      events,
      highWater,
      stale,
      replayFrom: events[0]?.id ?? null,
    };
  })();
}

export function getMigrationEventReplayWindow(
  migrationId: string,
  afterId: number,
): EventReplayWindow {
  return eventReplayWindow(migrationId, afterId);
}

export function getGlobalEventReplayWindow(afterId: number): EventReplayWindow {
  return eventReplayWindow(null, afterId);
}

function activityKind(eventType: string): ActivityKind {
  switch (eventType) {
    case "complete":
      return "succeeded";
    case "failure":
      return "failed";
    case "restart":
      return "restarted";
    default:
      return "notice";
  }
}

function activitySummary(eventType: string, payload: MigrationEvent["payload"]): string {
  if (eventType === "failure") {
    const detail = "detail" in payload ? payload.detail : undefined;
    return ("error" in payload && payload.error) || detail?.failureReason || "Migration failed";
  }
  if ((eventType === "restart" || eventType === "banner") && "message" in payload) {
    return payload.message;
  }
  return "";
}

export function getRecentActivity(limit = 20): ActivityItem[] {
  const placeholders = ACTIVITY_EVENT_TYPES.map(() => "?").join(", ");
  const rows = getDb()
    .prepare(
      `SELECT e.id AS id, e.migration_id AS migration_id, e.event_type AS event_type,
							e.payload AS payload, e.created_at AS created_at,
							m.source_org AS source_org, m.source_repo AS source_repo
			 FROM events e
			 JOIN migrations m ON m.id = e.migration_id
			 WHERE e.event_type IN (${placeholders})
				 AND m.source_provider IN (${EXECUTABLE_PROVIDER_SQL})
			 ORDER BY e.id DESC LIMIT ?`,
    )
    .all(...ACTIVITY_EVENT_TYPES, limit) as Record<string, unknown>[];
  const activity: ActivityItem[] = [];
  for (const row of rows) {
    const eventType = row.event_type as string;
    const payload = readEventPayload(row);
    if (!payload) continue;
    activity.push({
      id: row.id as number,
      migrationId: row.migration_id as string,
      kind: activityKind(eventType),
      repo: `${row.source_org as string}/${row.source_repo as string}`,
      summary: activitySummary(eventType, payload),
      createdAt: row.created_at as string,
    });
  }
  return activity;
}
