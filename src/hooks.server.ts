import { env } from "node:process";
import type { HandleServerError } from "@sveltejs/kit/hooks";
import { building, dev } from "$app/env";
import { profileStarters } from "$lib/server/application/adapters/profile-starters";
import { createMigrationSourceRuntime } from "$lib/server/application/adapters/source-runtime";
import { getCapabilityReport, logCapabilityReport } from "$lib/server/application/capabilities";
import { settleDashboardShutdown } from "$lib/server/application/dashboard-shutdown";
import { configureOperatorJobPolicy } from "$lib/server/application/self-service/jobs";
import { resolveSession, SESSION_COOKIE } from "$lib/server/core/auth/sessions";
import { initializeAuthentication } from "$lib/server/core/auth/startup";
import { pruneAuthRecords } from "$lib/server/core/auth/throttle";
import { closeStore, getDb, initStore } from "$lib/server/core/db";
import { acquireInstanceLock } from "$lib/server/core/instance-lock";
import { createRequestHandler } from "$lib/server/core/request-handler";
import { safeErrorReason } from "$lib/server/core/safe-error";
import { recoverInterruptedMigrations } from "$lib/server/migrate/database/schema";
import { recoverOrphans } from "$lib/server/migrate/manager";
import { configureMigrationSourceRuntime } from "$lib/server/migrate/ports/source-runtime";
import { dispatchProfiles } from "$lib/server/profile/database/queue";
import { stopActiveProfileRuns } from "$lib/server/profile/service";
import { DOMAIN_STORES } from "$lib/server/schemas";

const dataDirectory = env.DATA_DIR || "./data";
configureMigrationSourceRuntime(createMigrationSourceRuntime());
configureOperatorJobPolicy();
const instanceLock = acquireInstanceLock(dataDirectory);
let authEnabled = false;
let profileDispatch: ReturnType<typeof setInterval> | undefined;
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
    if (!authStartup.authEnabled) {
      console.warn(
        authStartup.unauthenticatedReason === "explicit"
          ? "[hooks] Unauthenticated mode explicitly enabled; anyone who can reach the app has operator access."
          : "[hooks] Development fallback to unauthenticated mode: no bootstrap credentials were found (GH_MIGRATE_USER and GH_MIGRATE_PASS) and GH_MIGRATE_ALLOW_UNAUTHENTICATED is unset. Anyone who can reach the app has operator access.",
      );
    }
  }
  logCapabilityReport(getCapabilityReport());
  recoverOrphans();
  if (!building)
    profileDispatch = setInterval(() => {
      try {
        dispatchProfiles((provider, namespace) => profileStarters[provider](namespace));
      } catch (error) {
        console.error("[profile queue] Dispatch failed", safeErrorReason(error));
      }
    }, 3000).unref();
} catch (error) {
  closeStore();
  instanceLock.release();
  throw error;
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[hooks] ${signal} received - shutting down`);
  clearInterval(profileDispatch);
  let exitCode = 1;
  try {
    exitCode = await settleDashboardShutdown(stopActiveProfileRuns, () =>
      recoverInterruptedMigrations(getDb()),
    );
  } finally {
    closeStore();
    instanceLock.release();
    process.exit(exitCode);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

export const handle = createRequestHandler({
  authEnabled,
  resolveSession,
  sessionCookie: SESSION_COOKIE,
});

export const handleError: HandleServerError = async ({ error, event, kind }) => {
  if (kind !== "unknown") return;
  const id = Bun.randomUUIDv7().slice(0, 8);
  console.error(
    `[error ${id}] ${event.request.method} ${event.url.pathname}`,
    safeErrorReason(error),
  );
  return { message: `Internal error (ref: ${id})`, code: id };
};
