import { patchMigrationFromEvent } from "$lib/migrate/events";
import type { Migration, MigrationEvent, PaginatedResult } from "$lib/migrate/types";
import { createReconnectingEventSource, isSseDoneMessage } from "$lib/sse";

let migrationRows = $state<Migration[]>([]);

export const migrations = {
  get value() {
    return migrationRows;
  },
  set value(value: Migration[]) {
    migrationRows = value;
  },
};

export async function refreshMigrations(): Promise<boolean> {
  try {
    const response = await fetch("/api/migrate");
    if (!response.ok) return false;
    const result = (await response.json()) as Migration[] | PaginatedResult<Migration>;
    migrationRows = Array.isArray(result) ? result : result.data;
    return true;
  } catch {
    return false;
  }
}

function applyMigrationEvent(event: MigrationEvent): void {
  migrationRows = migrationRows.map((migration) => patchMigrationFromEvent(migration, event));
}

export function createMigrationEventSource(migrationId: string, initialEventId?: number) {
  let events = $state<MigrationEvent[]>([]);
  let connected = $state(false);
  let lastEventId = initialEventId;

  const connection = createReconnectingEventSource({
    url: () =>
      lastEventId
        ? `/api/migrate/${migrationId}/events?after=${lastEventId}`
        : `/api/migrate/${migrationId}/events`,
    onConnectionChange: (value) => {
      connected = value;
    },
    onCursorStale: (event) => {
      try {
        const message = JSON.parse(event.data) as { highWater?: number };
        lastEventId = message.highWater;
        void refreshMigrations();
      } catch {
        lastEventId = undefined;
      }
    },
    onMessage: (event, controls) => {
      try {
        const message: unknown = JSON.parse(event.data);
        if (isSseDoneMessage(message)) {
          void refreshMigrations();
          controls.destroy();
          return;
        }
        const migrationEvent = message as MigrationEvent;
        if (migrationEvent.id && migrationEvent.id > (lastEventId ?? 0)) {
          lastEventId = migrationEvent.id;
        }
        events = [...events.slice(-500), migrationEvent];
        if (migrationEvent.eventType === "complete" || migrationEvent.eventType === "failure") {
          void refreshMigrations();
          controls.destroy();
        }
      } catch {
        // Ignore malformed event frames.
      }
    },
  });

  return {
    get events() {
      return events;
    },
    get connected() {
      return connected;
    },
    destroy: connection.destroy,
  };
}

export function createGlobalEventSource() {
  let events = $state<MigrationEvent[]>([]);
  let connected = $state(false);
  let stale = $state(false);
  let lastEventId: number | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const connection = createReconnectingEventSource({
    url: () => (lastEventId ? `/api/migrate/events?after=${lastEventId}` : "/api/migrate/events"),
    onConnectionChange: (value) => {
      connected = value;
      if (value) stale = false;
    },
    onRetriesExhausted: () => {
      stale = true;
      void refreshMigrations();
      if (!reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connection.reconnect();
        }, 5000);
      }
    },
    onCursorStale: (event) => {
      try {
        const message = JSON.parse(event.data) as { highWater?: number };
        lastEventId = message.highWater;
        void refreshMigrations();
      } catch {
        lastEventId = undefined;
      }
    },
    onMessage: (event) => {
      try {
        const migrationEvent = JSON.parse(event.data) as MigrationEvent;
        if (migrationEvent.id && migrationEvent.id > (lastEventId ?? 0)) {
          lastEventId = migrationEvent.id;
        }
        events = [...events.slice(-100), migrationEvent];
        applyMigrationEvent(migrationEvent);
      } catch {
        // Ignore malformed event frames.
      }
    },
  });

  function retry(): void {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    void refreshMigrations();
    connection.reconnect();
  }

  function destroy(): void {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    connection.destroy();
  }

  return {
    get events() {
      return events;
    },
    get connected() {
      return connected;
    },
    get stale() {
      return stale;
    },
    retry,
    destroy,
  };
}
