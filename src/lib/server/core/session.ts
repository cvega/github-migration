/**
 * Session and authentication utilities for the login system.
 * Extracted from hooks so it can be imported by both hooks.server.ts
 * and route handlers.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { building, dev } from "$app/environment";
import { env } from "$env/dynamic/private";

// ── Credentials ─────────────────────────────────────────────────────────────

export function resolveAuthMode(
  user: string | undefined,
  password: string | undefined,
  allowUnauthenticated: string | undefined,
  development = false,
): { authEnabled: boolean } {
  const hasUser = Boolean(user?.trim());
  const hasPassword = Boolean(password?.trim());
  const openValue = allowUnauthenticated?.trim().toLowerCase();

  if (openValue !== undefined && openValue !== "true" && openValue !== "false") {
    throw new Error("GH_MIGRATE_ALLOW_UNAUTHENTICATED must be either true or false.");
  }
  if (hasUser !== hasPassword) {
    throw new Error(
      hasUser
        ? "GH_MIGRATE_PASS is required when GH_MIGRATE_USER is set."
        : "GH_MIGRATE_USER is required when GH_MIGRATE_PASS is set.",
    );
  }
  if (hasUser) {
    if (openValue === "true") {
      throw new Error(
        "Authentication configuration is contradictory: credentials and unauthenticated mode are both enabled.",
      );
    }
    return { authEnabled: true };
  }
  if (development && openValue === undefined) {
    return { authEnabled: false };
  }
  if (openValue !== "true") {
    throw new Error(
      "Set GH_MIGRATE_USER and GH_MIGRATE_PASS, or explicitly set GH_MIGRATE_ALLOW_UNAUTHENTICATED=true.",
    );
  }
  return { authEnabled: false };
}

const authUser = env.GH_MIGRATE_USER;
const authPass = env.GH_MIGRATE_PASS;
export const { authEnabled } = building
  ? { authEnabled: false }
  : resolveAuthMode(authUser, authPass, env.GH_MIGRATE_ALLOW_UNAUTHENTICATED, dev);

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

export function resolveSessionSecret(authIsEnabled: boolean, secret: string | undefined) {
  if (!authIsEnabled) return "gh-migrate-no-auth";
  if (!secret || secret.length < 32) {
    throw new Error(
      "GH_MIGRATE_SESSION_SECRET must be at least 32 characters when authentication is enabled",
    );
  }
  return secret;
}

const SESSION_SECRET = resolveSessionSecret(authEnabled, env.GH_MIGRATE_SESSION_SECRET);

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
  if (dotIdx <= 0) return false;
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
  return issuedMs <= nowMs && nowMs - issuedMs <= SESSION_MAX_AGE * 1000;
}

// ── Rate limiting ───────────────────────────────────────────────────────────

const AUTH_MAX_ATTEMPTS = 5;
const AUTH_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_TRACKED_IPS = 10_000;
const failedAttempts = new Map<string, { count: number; firstAttempt: number }>();

/**
 * Whether an IP has reached five failed logins in the current 15-minute fixed
 * window. Expired entries are removed lazily here as well as by periodic
 * cleanup, so correctness does not depend on the cleanup timer running.
 */
export function isRateLimited(ip: string, nowMs: number = Date.now()): boolean {
  const entry = failedAttempts.get(ip);
  if (!entry) return false;
  if (nowMs - entry.firstAttempt > AUTH_WINDOW_MS) {
    failedAttempts.delete(ip);
    return false;
  }
  return entry.count >= AUTH_MAX_ATTEMPTS;
}

/**
 * Record one failed login for an IP. At most 10,000 IPs are retained in memory;
 * adding a new IP at that limit evicts the oldest tracked key. State is
 * process-local and intentionally resets on restart.
 */
export function recordFailedAttempt(
  ip: string,
  nowMs: number = Date.now(),
  maxTrackedIps = MAX_TRACKED_IPS,
): void {
  const entry = failedAttempts.get(ip);
  if (!entry || nowMs - entry.firstAttempt > AUTH_WINDOW_MS) {
    if (!entry && failedAttempts.size >= maxTrackedIps) {
      const oldest = failedAttempts.keys().next().value;
      if (oldest) failedAttempts.delete(oldest);
    }
    failedAttempts.set(ip, { count: 1, firstAttempt: nowMs });
  } else {
    entry.count++;
  }
}

export function resetRateLimitStateForTests(): void {
  failedAttempts.clear();
}

export function cleanupRateLimitState(nowMs: number = Date.now()): void {
  for (const [ip, entry] of failedAttempts) {
    if (nowMs - entry.firstAttempt > AUTH_WINDOW_MS) failedAttempts.delete(ip);
  }
}

// Periodically clean up stale entries (every 5 minutes).
setInterval(cleanupRateLimitState, 5 * 60 * 1000).unref();
