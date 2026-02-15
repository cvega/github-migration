/**
 * SvelteKit server hooks — optional basic auth, security headers,
 * graceful shutdown, and store initialization.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Handle, HandleServerError } from "@sveltejs/kit";
import { env } from "$env/dynamic/private";
import { recoverOrphans } from "$lib/server/manager";
import { closeStore, initStore } from "$lib/server/store";

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
const MAX_TRACKED_IPS = 10_000;
const failedAttempts = new Map<string, { count: number; firstAttempt: number }>();

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
    // Evict the oldest entry if at capacity.
    if (!entry && failedAttempts.size >= MAX_TRACKED_IPS) {
      const oldest = failedAttempts.keys().next().value;
      if (oldest) failedAttempts.delete(oldest);
    }
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
  // Content-Security-Policy is managed by SvelteKit's kit.csp config
  // (svelte.config.js) which auto-injects nonces for scripts.
};

export const handle: Handle = async ({ event, resolve }) => {
  if (authEnabled) {
    // Use SvelteKit's getClientAddress() which respects the ADDRESS_HEADER
    // env var (e.g. ADDRESS_HEADER=x-forwarded-for) when behind a trusted
    // reverse proxy.  Manually reading X-Forwarded-For here would allow
    // attackers to spoof IPs and bypass rate-limiting.
    const ip = event.getClientAddress();

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

    const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf-8");
    const colonIdx = decoded.indexOf(":");
    if (colonIdx < 0) {
      recordFailedAttempt(ip);
      return new Response("Forbidden", { status: 403 });
    }
    const user = decoded.slice(0, colonIdx);
    const pass = decoded.slice(colonIdx + 1);
    // Use HMAC-SHA256 comparison — produces fixed-length buffers regardless
    // of input length, eliminating the timing side-channel that a
    // length-check-before-timingSafeEqual pattern would introduce.
    const hmacKey = "gh-migrate-auth";
    const hmac = (v: string) => createHmac("sha256", hmacKey).update(v).digest();
    const userMatch = timingSafeEqual(hmac(user), hmac(authUser!));
    const passMatch = timingSafeEqual(hmac(pass), hmac(authPass!));
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
