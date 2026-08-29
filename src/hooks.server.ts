import type { HandleServerError } from "@sveltejs/kit";
import { env } from "$env/dynamic/private";
import { getCapabilityReport, logCapabilityReport } from "$lib/server/capability-report";
import { closeStore, getDb, initStore } from "$lib/server/core/db";
import { acquireInstanceLock } from "$lib/server/core/instance-lock";
import { createRequestHandler } from "$lib/server/core/request-handler";
import { authEnabled, isValidSession, SESSION_COOKIE } from "$lib/server/core/session";
import { recoverInterruptedMigrations } from "$lib/server/migrate/database/schema";
import { recoverOrphans } from "$lib/server/migrate/manager";
import { recoverInterruptedProfiles } from "$lib/server/profile/database/schema";
import { stopActiveProfileRuns } from "$lib/server/profile/service";
import { DOMAIN_STORES } from "$lib/server/schemas";

const dataDirectory = env.DATA_DIR || "./data";
const instanceLock = acquireInstanceLock(dataDirectory);
try {
  initStore(`${dataDirectory}/gh-migrate.db`, [...DOMAIN_STORES]);
  logCapabilityReport(getCapabilityReport());
  recoverOrphans();
} catch (error) {
  closeStore();
  instanceLock.release();
  throw error;
}

if (!authEnabled) {
  console.warn(
    "[hooks] Unauthenticated mode explicitly enabled; anyone who can reach the app has operator access.",
  );
}

function shutdown(signal: string): void {
  console.log(`[hooks] ${signal} received - shutting down`);
  recoverInterruptedMigrations(getDb());
  recoverInterruptedProfiles(getDb());
  stopActiveProfileRuns();
  closeStore();
  instanceLock.release();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export const handle = createRequestHandler({
  authEnabled,
  isValidSession,
  sessionCookie: SESSION_COOKIE,
});

export const handleError: HandleServerError = async ({ error, event }) => {
  const id = Bun.randomUUIDv7().slice(0, 8);
  console.error(`[error ${id}] ${event.request.method} ${event.url.pathname}`, error);
  return { message: `Internal error (ref: ${id})`, code: id };
};
