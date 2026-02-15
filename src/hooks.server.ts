/**
 * SvelteKit server hooks — optional basic auth, security headers,
 * graceful shutdown, and store initialization.
 */
import type { Handle, HandleServerError } from "@sveltejs/kit";
import { initStore, closeStore } from "$lib/server/store";
import { recoverOrphans } from "$lib/server/manager";
import { env } from "$env/dynamic/private";
import { timingSafeEqual } from "node:crypto";

// Initialize SQLite on server startup.
const dataDir = env.DATA_DIR || "./data";
initStore(`${dataDir}/gh-migrate.db`);

// Reconnect to any in-flight env-app migrations that survived the restart.
recoverOrphans();

const authUser = env.GH_MIGRATE_USER;
const authPass = env.GH_MIGRATE_PASS;
const authEnabled = !!(authUser && authPass);

if (!authEnabled) {
  console.warn(
    "[hooks] ⚠ No basic auth configured — the app is open to anyone who can reach it. " +
      "Set GH_MIGRATE_USER and GH_MIGRATE_PASS env vars to enable authentication.",
  );
}

// ── Auth rate limiting ───────────────────────────────────────────────────────

const AUTH_MAX_ATTEMPTS = 5;
const AUTH_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const failedAttempts = new Map<
  string,
  { count: number; firstAttempt: number }
>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = failedAttempts.get(ip);
  if (!entry) return false;
  if (now - entry.firstAttempt > AUTH_WINDOW_MS) {
    failedAttempts.delete(ip);
    return false;
  }
  return entry.count >= AUTH_MAX_ATTEMPTS;
}

function recordFailedAttempt(ip: string): void {
  const now = Date.now();
  const entry = failedAttempts.get(ip);
  if (!entry || now - entry.firstAttempt > AUTH_WINDOW_MS) {
    failedAttempts.set(ip, { count: 1, firstAttempt: now });
  } else {
    entry.count++;
  }
}

// Periodically clean up stale entries (every 5 minutes).
setInterval(
  () => {
    const now = Date.now();
    for (const [ip, entry] of failedAttempts) {
      if (now - entry.firstAttempt > AUTH_WINDOW_MS) failedAttempts.delete(ip);
    }
  },
  5 * 60 * 1000,
).unref();

// ── Graceful shutdown ───────────────────────────────────────────────────────

function shutdown(signal: string) {
  console.log(`[hooks] ${signal} received — shutting down`);
  closeStore();
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ── Security headers ────────────────────────────────────────────────────────

const securityHeaders: Record<string, string> = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'",
};

export const handle: Handle = async ({ event, resolve }) => {
  if (authEnabled) {
    const ip =
      event.request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      event.getClientAddress();

    if (isRateLimited(ip)) {
      return new Response("Too many failed attempts — try again later", {
        status: 429,
        headers: { "Retry-After": "900" },
      });
    }

    const authHeader = event.request.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Basic ")) {
      return new Response("Unauthorized", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="gh-migrate"' },
      });
    }

    const decoded = atob(authHeader.slice(6));
    const colonIdx = decoded.indexOf(":");
    if (colonIdx < 0) {
      recordFailedAttempt(ip);
      return new Response("Forbidden", { status: 403 });
    }
    const user = decoded.slice(0, colonIdx);
    const pass = decoded.slice(colonIdx + 1);
    const userMatch =
      user.length === authUser!.length &&
      timingSafeEqual(Buffer.from(user), Buffer.from(authUser!));
    const passMatch =
      pass.length === authPass!.length &&
      timingSafeEqual(Buffer.from(pass), Buffer.from(authPass!));
    if (!userMatch || !passMatch) {
      recordFailedAttempt(ip);
      return new Response("Forbidden", { status: 403 });
    }
  }

  const response = await resolve(event);

  // Apply security headers to every response.
  for (const [key, value] of Object.entries(securityHeaders)) {
    response.headers.set(key, value);
  }

  return response;
};

// ── Error handler ───────────────────────────────────────────────────────────

export const handleError: HandleServerError = async ({ error, event }) => {
  const id = crypto.randomUUID().slice(0, 8);
  console.error(
    `[error ${id}] ${event.request.method} ${event.url.pathname}`,
    error,
  );
  return {
    message: `Internal error (ref: ${id})`,
    code: id,
  };
};
