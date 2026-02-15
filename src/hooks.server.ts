/**
 * SvelteKit server hooks — optional cookie-based session auth, security
 * headers, graceful shutdown, and store initialization.
 */

import { redirect, type Handle, type HandleServerError } from "@sveltejs/kit";
import { env } from "$env/dynamic/private";
import { recoverOrphans } from "$lib/server/manager";
import {
  authEnabled,
  isRateLimited,
  isValidSession,
  SESSION_COOKIE,
} from "$lib/server/session";
import { closeStore, initStore } from "$lib/server/store";

// Initialize SQLite on server startup.
const dataDir = env.DATA_DIR || "./data";
initStore(`${dataDir}/gh-migrate.db`);

// Reconnect to any in-flight env-app migrations that survived the restart.
recoverOrphans();

if (!authEnabled) {
  console.warn(
    "[hooks] ⚠ No basic auth configured — the app is open to anyone who can reach it. " +
      "Set GH_MIGRATE_USER and GH_MIGRATE_PASS env vars to enable authentication.",
  );
}

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
  // Content-Security-Policy is managed by SvelteKit's kit.csp config
  // (svelte.config.js) which auto-injects nonces for scripts.
};

// Routes that don't require authentication.
const PUBLIC_PATHS = new Set(["/login", "/logout"]);

export const handle: Handle = async ({ event, resolve }) => {
  // Always set authEnabled so the layout can show/hide the logout button.
  event.locals.authEnabled = authEnabled;

  if (authEnabled) {
    const { pathname } = event.url;

    // Allow the login page and its POST handler through.
    if (PUBLIC_PATHS.has(pathname)) {
      // For the login page itself, just continue to resolve.
      const response = await resolve(event);
      for (const [key, value] of Object.entries(securityHeaders)) {
        response.headers.set(key, value);
      }
      return response;
    }

    // Check session cookie.
    const sessionCookie = event.cookies.get(SESSION_COOKIE);
    if (!sessionCookie || !isValidSession(sessionCookie)) {
      // API requests get 401; page requests redirect to login.
      if (pathname.startsWith("/api/")) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      redirect(302, "/login");
    }
  }

  const response = await resolve(event);

  // Apply security headers to every response.
  for (const [key, value] of Object.entries(securityHeaders)) {
    response.headers.set(key, value);
  }

  // Compress HTML/JSON SSR responses (static assets are precompressed by adapter-node).
  const contentType = response.headers.get("content-type") || "";
  const acceptEncoding = event.request.headers.get("accept-encoding") || "";
  const isCompressible =
    contentType.includes("text/html") || contentType.includes("application/json");
  if (isCompressible && !response.headers.has("content-encoding") && response.body) {
    const encoding = acceptEncoding.includes("gzip") ? "gzip" : null;
    if (encoding) {
      const compressed = response.body.pipeThrough(new CompressionStream(encoding));
      const headers = new Headers(response.headers);
      headers.set("content-encoding", encoding);
      headers.delete("content-length");
      return new Response(compressed, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
  }

  return response;
};

// ── Error handler ───────────────────────────────────────────────────────────

export const handleError: HandleServerError = async ({ error, event }) => {
  const id = Bun.randomUUIDv7().slice(0, 8);
  console.error(`[error ${id}] ${event.request.method} ${event.url.pathname}`, error);
  return {
    message: `Internal error (ref: ${id})`,
    code: id,
  };
};
