/**
 * Characterization tests for the reconnecting EventSource transport.
 *
 * EventSource (a browser API) and setTimeout are replaced with controllable
 * fakes so the connect → open → message → error → backoff-reconnect → destroy
 * lifecycle can be asserted deterministically without real network or timers.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  backoffDelay,
  createReconnectingEventSource,
  type ReconnectingEventSourceOptions,
} from "./sse-client";

// ── Fakes ────────────────────────────────────────────────────────────────────

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  /** Simulate the connection opening. */
  emitOpen() {
    this.onopen?.();
  }

  /** Simulate an inbound SSE message carrying `data`. */
  emitMessage(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }

  /** Simulate a transport error. */
  emitError() {
    this.onerror?.();
  }
}

/** Captured setTimeout calls so we can run reconnects on demand. */
let scheduled: Array<{ fn: () => void; delay: number }>;
let realSetTimeout: typeof globalThis.setTimeout;
let realEventSource: typeof globalThis.EventSource;

beforeEach(() => {
  FakeEventSource.instances = [];
  scheduled = [];
  realSetTimeout = globalThis.setTimeout;
  realEventSource = globalThis.EventSource;
  globalThis.EventSource = FakeEventSource as unknown as typeof globalThis.EventSource;
  // Capture (don't run) scheduled reconnects; return a dummy handle.
  globalThis.setTimeout = ((fn: () => void, delay?: number) => {
    scheduled.push({ fn, delay: delay ?? 0 });
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof globalThis.setTimeout;
});

afterEach(() => {
  globalThis.setTimeout = realSetTimeout;
  globalThis.EventSource = realEventSource;
});

function latest(): FakeEventSource {
  const es = FakeEventSource.instances.at(-1);
  if (!es) throw new Error("no EventSource was constructed");
  return es;
}

/** Minimal options with no-op message handling unless overridden. */
function options(
  over: Partial<ReconnectingEventSourceOptions> = {},
): ReconnectingEventSourceOptions {
  return { url: () => "/api/events", onMessage: () => {}, ...over };
}

// ── backoffDelay ──────────────────────────────────────────────────────────────

describe("backoffDelay", () => {
  test("grows exponentially within the 50-100% jitter band", () => {
    // attempt 0 → base 1000ms, so result ∈ [500, 1000].
    for (let i = 0; i < 50; i++) {
      const d = backoffDelay(0);
      expect(d).toBeGreaterThanOrEqual(500);
      expect(d).toBeLessThanOrEqual(1000);
    }
    // attempt 2 → 4000ms base, so result ∈ [2000, 4000].
    const d2 = backoffDelay(2);
    expect(d2).toBeGreaterThanOrEqual(2000);
    expect(d2).toBeLessThanOrEqual(4000);
  });

  test("caps the exponential at 30s (high attempts stay within [15000, 30000])", () => {
    for (let i = 0; i < 50; i++) {
      const d = backoffDelay(40);
      expect(d).toBeGreaterThanOrEqual(15_000);
      expect(d).toBeLessThanOrEqual(30_000);
    }
  });
});

// ── lifecycle ───────────────────────────────────────────────────────────────

describe("createReconnectingEventSource", () => {
  test("connects to url() immediately", () => {
    createReconnectingEventSource(options({ url: () => "/api/events?x=1" }));
    expect(latest().url).toBe("/api/events?x=1");
  });

  test("reports connection state on open and error", () => {
    const states: boolean[] = [];
    createReconnectingEventSource(options({ onConnectionChange: (c) => states.push(c) }));
    latest().emitOpen();
    latest().emitError();
    expect(states).toEqual([true, false]);
  });

  test("forwards parsed messages with destroy controls", () => {
    const received: unknown[] = [];
    createReconnectingEventSource(options({ onMessage: (e) => received.push(JSON.parse(e.data)) }));
    latest().emitMessage({ hello: "world" });
    expect(received).toEqual([{ hello: "world" }]);
  });

  test("closes and schedules a reconnect on error", () => {
    createReconnectingEventSource(options());
    const first = latest();
    first.emitError();
    expect(first.closed).toBe(true);
    expect(scheduled).toHaveLength(1);

    // Running the scheduled callback opens a fresh EventSource.
    scheduled[0]?.fn();
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  test("re-reads url() on reconnect (resumption cursor)", () => {
    let cursor = 0;
    createReconnectingEventSource(options({ url: () => `/api/events?after=${cursor}` }));
    expect(latest().url).toBe("/api/events?after=0");
    cursor = 42;
    latest().emitError();
    scheduled[0]?.fn();
    expect(latest().url).toBe("/api/events?after=42");
  });

  test("resets the retry counter after a successful open", () => {
    createReconnectingEventSource(options());
    // Two failures schedule reconnects with increasing attempts.
    latest().emitError();
    scheduled[0]?.fn();
    latest().emitError();
    const delayBeforeReset = scheduled[1]?.delay ?? 0;
    scheduled[1]?.fn();
    // A successful open resets retryCount, so the next error backs off from 0 again.
    latest().emitOpen();
    latest().emitError();
    const delayAfterReset = scheduled[2]?.delay ?? 0;
    // After reset the delay is drawn from attempt 0 (≤1000); pre-reset was attempt ≥1 (≥1000 base).
    expect(delayAfterReset).toBeLessThanOrEqual(1000);
    expect(delayBeforeReset).toBeGreaterThanOrEqual(1000);
  });

  test("destroy() closes the source and prevents further reconnects", () => {
    const conn = createReconnectingEventSource(options());
    const es = latest();
    conn.destroy();
    expect(es.closed).toBe(true);

    // An error after destroy must not schedule a reconnect.
    es.emitError();
    expect(scheduled).toHaveLength(0);
  });

  test("destroy() runs onDestroy cleanup and reports disconnected", () => {
    const states: boolean[] = [];
    let cleanedUp = false;
    const conn = createReconnectingEventSource(
      options({
        onConnectionChange: (c) => states.push(c),
        onDestroy: () => {
          cleanedUp = true;
        },
      }),
    );
    conn.destroy();
    expect(cleanedUp).toBe(true);
    expect(states.at(-1)).toBe(false);
  });

  test("the message handler can stop the stream via controls.destroy()", () => {
    createReconnectingEventSource(
      options({
        onMessage: (e, controls) => {
          const evt = JSON.parse(e.data) as { terminal?: boolean };
          if (evt.terminal) controls.destroy();
        },
      }),
    );
    const es = latest();
    es.emitMessage({ terminal: true });
    expect(es.closed).toBe(true);
    // Subsequent errors don't reconnect (stream was destroyed).
    es.emitError();
    expect(scheduled).toHaveLength(0);
  });
});
