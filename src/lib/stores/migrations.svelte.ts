/**
 * Svelte 5 rune-based reactive state for migration data and SSE event sources.
 */
import { createReconnectingEventSource } from "$lib/stores/sse-client";
import type { Migration, MigrationEvent } from "$lib/types";

// ── Migrations state ────────────────────────────────────────────────────────

let _migrations = $state<Migration[]>([]);

export const migrations = {
  get value() {
    return _migrations;
  },
  set value(v: Migration[]) {
    _migrations = v;
  },
};

export async function refreshMigrations(): Promise<void> {
  const res = await fetch("/api/migrate/migrations");
  if (res.ok) {
    const result = await res.json();
    // API now returns PaginatedResult, extract data array.
    _migrations = Array.isArray(result) ? result : result.data;
  }
}

// ── SSE event source for a single migration ─────────────────────────────────

export function createMigrationEventSource(migrationId: string) {
  let _events = $state<MigrationEvent[]>([]);
  let _connected = $state(false);
  let lastEventId: number | undefined;

  const conn = createReconnectingEventSource({
    url: () =>
      lastEventId
        ? `/api/migrate/migrations/${migrationId}/events?after=${lastEventId}`
        : `/api/migrate/migrations/${migrationId}/events`,
    onConnectionChange: (connected) => {
      _connected = connected;
    },
    onMessage: (e, controls) => {
      try {
        const event = JSON.parse(e.data) as MigrationEvent;
        if (event.id && event.id > (lastEventId ?? 0)) {
          lastEventId = event.id;
        }
        _events = [..._events.slice(-500), event];

        // Stop reconnecting on terminal events.
        if (event.eventType === "complete" || event.eventType === "failure") {
          refreshMigrations();
          controls.destroy();
        }
      } catch {
        // Ignore malformed events.
      }
    },
  });

  return {
    get events() {
      return _events;
    },
    get connected() {
      return _connected;
    },
    destroy: conn.destroy,
  };
}

// ── Global SSE for dashboard ────────────────────────────────────────────────

export function createGlobalEventSource() {
  let _events = $state<MigrationEvent[]>([]);
  let _connected = $state(false);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const conn = createReconnectingEventSource({
    url: () => "/api/migrate/events",
    onConnectionChange: (connected) => {
      _connected = connected;
    },
    onMessage: (e) => {
      try {
        const event = JSON.parse(e.data) as MigrationEvent;
        _events = [..._events.slice(-100), event]; // keep last 100
        // Debounce refreshMigrations to avoid parallel fetches on rapid SSE bursts.
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(refreshMigrations, 300);
      } catch {
        // Ignore
      }
    },
    onDestroy: () => {
      if (debounceTimer) clearTimeout(debounceTimer);
    },
  });

  return {
    get events() {
      return _events;
    },
    get connected() {
      return _connected;
    },
    destroy: conn.destroy,
  };
}
