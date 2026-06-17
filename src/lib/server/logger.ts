import { pino } from "pino";

/**
 * Process-wide structured logger.
 *
 * Emits NDJSON to stdout so any log shipper (promtail/vector/fluent-bit)
 * can parse it without app-side coupling. Use the `event` field to
 * classify lines for downstream alerting and debugging.
 *
 * Convention: pass `{ event: "domain.action", ...fields }` as the first
 * argument and a short human message as the second. Field names are
 * camelCase. Never log passwords, tokens, session ids, or full request
 * bodies.
 */
export const logger = pino({
	level: process.env.LOG_LEVEL ?? "info",
});
