import type { HandleServerError } from "@sveltejs/kit";
import { building, dev } from "$app/environment";
import { env } from "$env/dynamic/private";
import { createMigrationSourceRuntime } from "$lib/server/application/adapters/source-runtime";
import { getCapabilityReport, logCapabilityReport } from "$lib/server/application/capabilities";
import { resolveSession, SESSION_COOKIE } from "$lib/server/core/auth/sessions";
import { initializeAuthentication } from "$lib/server/core/auth/startup";
import { pruneAuthRecords } from "$lib/server/core/auth/throttle";
import { closeStore, getDb, initStore } from "$lib/server/core/db";
import { acquireInstanceLock } from "$lib/server/core/instance-lock";
import { createRequestHandler } from "$lib/server/core/request-handler";
import { recoverInterruptedMigrations } from "$lib/server/migrate/database/schema";
import { recoverOrphans } from "$lib/server/migrate/manager";
import { configureMigrationSourceRuntime } from "$lib/server/migrate/ports/source-runtime";
import { recoverInterruptedProfiles } from "$lib/server/profile/database/schema";
import { stopActiveProfileRuns } from "$lib/server/profile/service";
import { DOMAIN_STORES } from "$lib/server/schemas";

const dataDirectory = env.DATA_DIR || "./data";
configureMigrationSourceRuntime(createMigrationSourceRuntime());
const instanceLock = acquireInstanceLock(dataDirectory);
let authEnabled = false;
try {
  initStore(`${dataDirectory}/gh-migrate.db`, [...DOMAIN_STORES]);
  if (!building) {
    const authStartup = await initializeAuthentication(
      {
        username: env.GH_MIGRATE_USER,
        password: env.GH_MIGRATE_PASS,
        allowUnauthenticated: env.GH_MIGRATE_ALLOW_UNAUTHENTICATED,
        development: dev,
      },
      getDb(),
    );
    authEnabled = authStartup.authEnabled;
    pruneAuthRecords();
    if (authStartup.bootstrappedUser) {
      console.log("[auth] Created the first administrator from bootstrap credentials");
    }
    if (env.GH_MIGRATE_SESSION_SECRET) {
      console.warn("[auth] GH_MIGRATE_SESSION_SECRET is deprecated and no longer used");
    }
  }
  logCapabilityReport(getCapabilityReport());
  recoverOrphans();
} catch (error) {
  closeStore();
  instanceLock.release();
  throw error;
}

if (!building && !authEnabled) {
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
  resolveSession,
  sessionCookie: SESSION_COOKIE,
});

export const handleError: HandleServerError = async ({ error, event }) => {
  const id = Bun.randomUUIDv7().slice(0, 8);
  console.error(`[error ${id}] ${event.request.method} ${event.url.pathname}`, error);
  return { message: `Internal error (ref: ${id})`, code: id };
};
