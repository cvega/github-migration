/**
 * Framework-agnostic reconnecting EventSource client.
 *
 * Owns the SSE connection lifecycle and the exponential-backoff reconnect
 * policy; the caller supplies the URL (re-read on every (re)connect, so it can
 * carry a resumption cursor), a message handler, and optional connection-state
 * and cleanup callbacks. Deliberately rune-free so the reconnect logic is
 * unit-testable — the reactive state ($state) lives in the calling stores.
 */

// Exponential backoff with jitter: 1s → 2s → 4s → ... capped at 30s.
// Gives up after MAX_RETRIES to avoid hammering a dead server forever.
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;
const MAX_RETRIES = 20;

/** Backoff delay (ms) for a 0-based retry attempt: capped exponential, 50-100% jitter. */
export function backoffDelay(attempt: number): number {
  const exponential = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
  const jitter = exponential * (0.5 + Math.random() * 0.5); // 50-100% of delay
  return Math.round(jitter);
}

/** Controls handed to the message handler so it can tear down on terminal events. */
interface EventSourceControls {
  destroy: () => void;
}

export interface ReconnectingEventSourceOptions {
  /** Returns the URL to connect to; re-read on every (re)connect. */
  url: () => string;
  /** Handle an incoming message. Receives controls to stop the stream. */
  onMessage: (event: MessageEvent, controls: EventSourceControls) => void;
  /** Notified whenever the connected state changes (open → true, error/destroy → false). */
  onConnectionChange?: (connected: boolean) => void;
  /** Extra cleanup to run on destroy (e.g. clearing a debounce timer). */
  onDestroy?: () => void;
}

export interface ReconnectingEventSource {
  destroy: () => void;
}

/**
 * Open an EventSource that automatically reconnects with capped exponential
 * backoff until {@link ReconnectingEventSourceOptions.onMessage} (via its
 * controls) or {@link ReconnectingEventSource.destroy} stops it.
 */
export function createReconnectingEventSource(
  opts: ReconnectingEventSourceOptions,
): ReconnectingEventSource {
  let source: EventSource | null = null;
  let destroyed = false;
  let retryCount = 0;

  function connect(): void {
    if (destroyed) return;

    source = new EventSource(opts.url());

    source.onopen = () => {
      retryCount = 0;
      opts.onConnectionChange?.(true);
    };

    source.onmessage = (event) => opts.onMessage(event, { destroy });

    source.onerror = () => {
      source?.close();
      opts.onConnectionChange?.(false);
      if (!destroyed && retryCount < MAX_RETRIES) {
        setTimeout(connect, backoffDelay(retryCount++));
      }
    };
  }

  function destroy(): void {
    destroyed = true;
    opts.onConnectionChange?.(false);
    opts.onDestroy?.();
    source?.close();
    source = null;
  }

  connect();

  return { destroy };
}
