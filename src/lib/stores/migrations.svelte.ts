/**
 * Svelte 5 rune-based reactive state for migration data and SSE event sources.
 */
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
  const res = await fetch("/api/migrations");
  if (res.ok) {
    const result = await res.json();
    // API now returns PaginatedResult, extract data array.
    _migrations = Array.isArray(result) ? result : result.data;
  }
}

// ── SSE reconnect policy ────────────────────────────────────────────────────
// Exponential backoff with jitter: 1s → 2s → 4s → ... capped at 30s.
// Gives up after MAX_RETRIES to avoid infinite loops against a dead server.

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;
const MAX_RETRIES = 20;

function backoffDelay(attempt: number): number {
  const exponential = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
  const jitter = exponential * (0.5 + Math.random() * 0.5); // 50-100% of delay
  return Math.round(jitter);
}

// ── SSE event source for a single migration ─────────────────────────────────

export function createMigrationEventSource(migrationId: string) {
  let _events = $state<MigrationEvent[]>([]);
  let _connected = $state(false);
  let lastEventId: number | undefined;
  let source: EventSource | null = null;
  let destroyed = false;
  let retryCount = 0;

  function connect() {
    if (destroyed) return;

    const url = lastEventId
      ? `/api/migrations/${migrationId}/events?after=${lastEventId}`
      : `/api/migrations/${migrationId}/events`;

    source = new EventSource(url);

    source.onopen = () => {
      retryCount = 0;
      _connected = true;
    };

    source.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as MigrationEvent;
        if (event.id && event.id > (lastEventId ?? 0)) {
          lastEventId = event.id;
        }
        _events = [..._events.slice(-500), event];

        // Stop reconnecting on terminal events.
        if (event.eventType === "complete" || event.eventType === "failure") {
          refreshMigrations();
          destroy();
        }
      } catch {
        // Ignore malformed events.
      }
    };

    source.onerror = () => {
      source?.close();
      _connected = false;
      if (!destroyed && retryCount < MAX_RETRIES) {
        const delay = backoffDelay(retryCount++);
        setTimeout(connect, delay);
      }
    };
  }

  connect();

  function destroy() {
    destroyed = true;
    _connected = false;
    source?.close();
    source = null;
  }

  return {
    get events() {
      return _events;
    },
    get connected() {
      return _connected;
    },
    destroy,
  };
}

// ── Global SSE for dashboard ────────────────────────────────────────────────

export function createGlobalEventSource() {
  let _events = $state<MigrationEvent[]>([]);
  let _connected = $state(false);
  let source: EventSource | null = null;
  let destroyed = false;
  let retryCount = 0;

  function connect() {
    if (destroyed) return;

    source = new EventSource("/api/events");

    source.onopen = () => {
      retryCount = 0;
      _connected = true;
    };

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    source.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as MigrationEvent;
        _events = [..._events.slice(-100), event]; // keep last 100
        // Debounce refreshMigrations to avoid parallel fetches on rapid SSE bursts.
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(refreshMigrations, 300);
      } catch {
        // Ignore
      }
    };

    source.onerror = () => {
      source?.close();
      _connected = false;
      if (!destroyed && retryCount < MAX_RETRIES) {
        const delay = backoffDelay(retryCount++);
        setTimeout(connect, delay);
      }
    };
  }

  connect();

  function destroy() {
    destroyed = true;
    _connected = false;
    source?.close();
    source = null;
  }

  return {
    get events() {
      return _events;
    },
    get connected() {
      return _connected;
    },
    destroy,
  };
}
