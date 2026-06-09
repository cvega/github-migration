/**
 * Session and authentication utilities for the login system.
 * Extracted from hooks so it can be imported by both hooks.server.ts
 * and route handlers.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "$env/dynamic/private";

// ── Credentials ─────────────────────────────────────────────────────────────

const authUser = env.GH_MIGRATE_USER;
const authPass = env.GH_MIGRATE_PASS;
export const authEnabled = !!(authUser && authPass);

/** Validate user/pass with timing-safe comparison. */
export function validateCredentials(user: string, pass: string): boolean {
  if (!authUser || !authPass) return false;
  const hmacKey = "gh-migrate-auth";
  const hmac = (v: string) => createHmac("sha256", hmacKey).update(v).digest();
  const userMatch = timingSafeEqual(hmac(user), hmac(authUser));
  const passMatch = timingSafeEqual(hmac(pass), hmac(authPass));
  return userMatch && passMatch;
}

// ── Session cookie signing ──────────────────────────────────────────────────

// Derive a signing key from the password so sessions are invalidated on
// credential change. Falls back to a static key when auth is disabled.
const SESSION_SECRET = authPass
  ? createHmac("sha256", "gh-migrate-session-key").update(authPass).digest("hex")
  : "gh-migrate-no-auth";

export const SESSION_COOKIE = "gh_migrate_session";
export const SESSION_MAX_AGE = 7 * 24 * 60 * 60; // 7 days in seconds

/** Create a signed session token: `timestamp.hmac` */
export function createSessionToken(nowMs: number = Date.now()): string {
  const ts = nowMs.toString(36);
  const sig = createHmac("sha256", SESSION_SECRET).update(ts).digest("hex");
  return `${ts}.${sig}`;
}

/**
 * Validate a session token: the signature must verify **and** the signed
 * issue time must be within `SESSION_MAX_AGE`. Enforcing expiry server-side
 * (not just via the cookie's own `maxAge`) prevents a captured token from
 * being replayed indefinitely.
 */
export function isValidSession(token: string, nowMs: number = Date.now()): boolean {
  const dotIdx = token.indexOf(".");
  if (dotIdx < 0) return false;
  const ts = token.slice(0, dotIdx);
  const sig = token.slice(dotIdx + 1);
  const expected = createHmac("sha256", SESSION_SECRET).update(ts).digest("hex");
  if (sig.length !== expected.length) return false;
  let signatureValid: boolean;
  try {
    signatureValid = timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
  if (!signatureValid) return false;

  // The timestamp is part of the signed payload, so it can be trusted once the
  // signature checks out. Reject tokens older than the session lifetime.
  const issuedMs = Number.parseInt(ts, 36);
  if (!Number.isFinite(issuedMs)) return false;
  return nowMs - issuedMs <= SESSION_MAX_AGE * 1000;
}

// ── Rate limiting ───────────────────────────────────────────────────────────

const AUTH_MAX_ATTEMPTS = 5;
const AUTH_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_TRACKED_IPS = 10_000;
const failedAttempts = new Map<string, { count: number; firstAttempt: number }>();

export function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = failedAttempts.get(ip);
  if (!entry) return false;
  if (now - entry.firstAttempt > AUTH_WINDOW_MS) {
    failedAttempts.delete(ip);
    return false;
  }
  return entry.count >= AUTH_MAX_ATTEMPTS;
}

export function recordFailedAttempt(ip: string): void {
  const now = Date.now();
  const entry = failedAttempts.get(ip);
  if (!entry || now - entry.firstAttempt > AUTH_WINDOW_MS) {
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
