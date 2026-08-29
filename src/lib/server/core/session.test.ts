import { beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  cleanupRateLimitState,
  createSessionToken,
  isRateLimited,
  isValidSession,
  recordFailedAttempt,
  resetRateLimitStateForTests,
  resolveAuthMode,
  resolveSessionSecret,
  SESSION_COOKIE,
  SESSION_MAX_AGE,
} from "./session";

describe("authentication configuration", () => {
  test("accepts a complete credential pair", () => {
    expect(resolveAuthMode("admin", "secret", undefined)).toEqual({ authEnabled: true });
    expect(resolveAuthMode("admin", "secret", "false")).toEqual({ authEnabled: true });
  });

  test("requires explicit opt-in when credentials are absent", () => {
    expect(resolveAuthMode(undefined, undefined, "true")).toEqual({ authEnabled: false });
    expect(() => resolveAuthMode(undefined, undefined, undefined)).toThrow(
      /GH_MIGRATE_ALLOW_UNAUTHENTICATED=true/,
    );
  });

  test("allows an entirely unconfigured development server", () => {
    expect(resolveAuthMode(undefined, undefined, undefined, true)).toEqual({ authEnabled: false });
  });

  test("treats whitespace-only credentials as absent", () => {
    expect(resolveAuthMode("  ", "\t", "true")).toEqual({ authEnabled: false });
  });

  test("honors explicit unauthenticated denial in development", () => {
    expect(() => resolveAuthMode(undefined, undefined, "false", true)).toThrow(
      /GH_MIGRATE_ALLOW_UNAUTHENTICATED=true/,
    );
  });

  test("rejects partial, contradictory, and malformed configuration", () => {
    expect(() => resolveAuthMode("admin", undefined, "true")).toThrow(/GH_MIGRATE_PASS/);
    expect(() => resolveAuthMode(undefined, "secret", "true")).toThrow(/GH_MIGRATE_USER/);
    expect(() => resolveAuthMode("admin", "secret", "true")).toThrow(/contradictory/i);
    expect(() => resolveAuthMode(undefined, undefined, "yes")).toThrow(/true.*false/i);
  });
});

describe("session tokens", () => {
  test("uses the stable session cookie name", () => {
    expect(SESSION_COOKIE).toBe("gh_migrate_session");
  });

  test("requires an independent secret when authentication is enabled", () => {
    expect(() => resolveSessionSecret(true, undefined)).toThrow(
      /GH_MIGRATE_SESSION_SECRET.*32 characters/,
    );
    expect(() => resolveSessionSecret(true, "short")).toThrow();
    expect(resolveSessionSecret(false, undefined)).toBe("gh-migrate-no-auth");
    expect(resolveSessionSecret(true, "s".repeat(32))).toBe("s".repeat(32));
  });

  test("a freshly created token validates", () => {
    expect(isValidSession(createSessionToken())).toBe(true);
  });

  test("rejects a token with a tampered signature", () => {
    const token = createSessionToken();
    const dot = token.indexOf(".");
    const tampered = `${token.slice(0, dot + 1)}${"0".repeat(token.length - dot - 1)}`;
    expect(isValidSession(tampered)).toBe(false);
  });

  test("rejects a token with a tampered timestamp", () => {
    const token = createSessionToken();
    const sig = token.slice(token.indexOf(".") + 1);
    expect(isValidSession(`deadbeef.${sig}`)).toBe(false);
  });

  test("rejects a same-length signature that is not valid hex", () => {
    const token = createSessionToken();
    const dot = token.indexOf(".");
    const signatureLength = token.length - dot - 1;

    expect(isValidSession(`${token.slice(0, dot + 1)}${"z".repeat(signatureLength)}`)).toBe(false);
  });

  test("rejects malformed tokens", () => {
    expect(isValidSession("")).toBe(false);
    expect(isValidSession("no-dot-here")).toBe(false);
    expect(isValidSession(".")).toBe(false);
  });

  test("rejects a correctly signed nonnumeric timestamp", () => {
    const secret = process.env.GH_MIGRATE_SESSION_SECRET;
    if (!secret) throw new Error("Test session secret is not configured");
    const timestamp = "!";
    const signature = createHmac("sha256", secret).update(timestamp).digest("hex");

    expect(isValidSession(`${timestamp}.${signature}`)).toBe(false);
  });

  test("rejects a correctly signed empty timestamp", () => {
    const secret = process.env.GH_MIGRATE_SESSION_SECRET;
    if (!secret) throw new Error("Test session secret is not configured");
    const signature = createHmac("sha256", secret).update("").digest("hex");

    expect(isValidSession(`.${signature}`)).toBe(false);
  });
});

describe("session expiry", () => {
  const issuedAt = 1_700_000_000_000;
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

  test("uses the required seven-day session lifetime", () => {
    expect(SESSION_MAX_AGE * 1000).toBe(sevenDaysMs);
  });

  test("validates a token within its lifetime", () => {
    const token = createSessionToken(issuedAt);
    expect(isValidSession(token, issuedAt + 60_000)).toBe(true);
  });

  test("validates a token issued at the current instant", () => {
    const token = createSessionToken(issuedAt);
    expect(isValidSession(token, issuedAt)).toBe(true);
  });

  test("validates a token exactly at the expiry boundary", () => {
    const token = createSessionToken(issuedAt);
    expect(isValidSession(token, issuedAt + sevenDaysMs)).toBe(true);
  });

  test("rejects a token past its lifetime", () => {
    const token = createSessionToken(issuedAt);
    expect(isValidSession(token, issuedAt + sevenDaysMs + 1)).toBe(false);
  });

  test("rejects a token issued in the future", () => {
    const token = createSessionToken(issuedAt + 1);
    expect(isValidSession(token, issuedAt)).toBe(false);
  });
});

describe("login rate limiting", () => {
  let ipCounter = 0;
  const freshIp = () => `10.0.0.${ipCounter++}`;

  beforeEach(() => {
    resetRateLimitStateForTests();
  });

  test("a fresh IP is not rate limited", () => {
    expect(isRateLimited(freshIp())).toBe(false);
  });

  test("does not limit until the attempt threshold is reached", () => {
    const ip = freshIp();
    // Threshold is 5 — four failures must still be allowed.
    for (let i = 0; i < 4; i++) recordFailedAttempt(ip);
    expect(isRateLimited(ip)).toBe(false);
  });

  test("limits once the threshold (5 failures) is reached", () => {
    const ip = freshIp();
    for (let i = 0; i < 5; i++) recordFailedAttempt(ip);
    expect(isRateLimited(ip)).toBe(true);
  });

  test("stays limited beyond the threshold", () => {
    const ip = freshIp();
    for (let i = 0; i < 8; i++) recordFailedAttempt(ip);
    expect(isRateLimited(ip)).toBe(true);
  });

  test("an unrelated IP failure does not clear an existing lockout", () => {
    const lockedIp = freshIp();
    for (let i = 0; i < 5; i++) recordFailedAttempt(lockedIp);

    recordFailedAttempt(freshIp());

    expect(isRateLimited(lockedIp)).toBe(true);
  });

  test("tracking is bounded and evicts the oldest entry at capacity", () => {
    const capacity = 3;
    const oldestIp = freshIp();
    for (let i = 0; i < 5; i++) recordFailedAttempt(oldestIp, Date.now(), capacity);
    recordFailedAttempt(freshIp(), Date.now(), capacity);
    recordFailedAttempt(freshIp(), Date.now(), capacity);
    expect(isRateLimited(oldestIp)).toBe(true);

    const newestIp = freshIp();
    for (let i = 0; i < 5; i++) recordFailedAttempt(newestIp, Date.now(), capacity);

    expect(isRateLimited(oldestIp)).toBe(false);
    expect(isRateLimited(newestIp)).toBe(true);
  });

  // ── Window expiry (uses the injectable clock; AUTH_WINDOW_MS is 15 minutes) ──
  const WINDOW_MS = 15 * 60 * 1000;
  const t0 = 1_700_000_000_000;

  test("a limited IP is no longer limited once the window has elapsed", () => {
    const ip = freshIp();
    for (let i = 0; i < 5; i++) recordFailedAttempt(ip, t0);
    expect(isRateLimited(ip, t0)).toBe(true);
    // Just past the window — the stale entry is cleared and the IP is freed.
    expect(isRateLimited(ip, t0 + WINDOW_MS + 1)).toBe(false);
  });

  test("stays limited at the exact window boundary (expiry is strictly past it)", () => {
    const ip = freshIp();
    for (let i = 0; i < 5; i++) recordFailedAttempt(ip, t0);
    // Exactly at the window edge the entry has not yet expired.
    expect(isRateLimited(ip, t0 + WINDOW_MS)).toBe(true);
  });

  test("a failure after the window resets the counter (slow drip never trips)", () => {
    const ip = freshIp();
    for (let i = 0; i < 4; i++) recordFailedAttempt(ip, t0);
    // This 5th attempt lands after the window, so it starts a fresh window at count 1.
    recordFailedAttempt(ip, t0 + WINDOW_MS + 1);
    expect(isRateLimited(ip, t0 + WINDOW_MS + 1)).toBe(false);
  });

  test("a failure at the exact window boundary remains in the original window", () => {
    const ip = freshIp();
    for (let i = 0; i < 4; i++) recordFailedAttempt(ip, t0);

    recordFailedAttempt(ip, t0 + WINDOW_MS);

    expect(isRateLimited(ip, t0 + WINDOW_MS)).toBe(true);
  });

  test("a failure after expiry starts a complete fresh window", () => {
    const ip = freshIp();
    for (let i = 0; i < 4; i++) recordFailedAttempt(ip, t0);

    const nextWindow = t0 + WINDOW_MS + 1;
    recordFailedAttempt(ip, nextWindow);
    for (let i = 0; i < 3; i++) recordFailedAttempt(ip, nextWindow);
    expect(isRateLimited(ip, nextWindow)).toBe(false);

    recordFailedAttempt(ip, nextWindow);
    expect(isRateLimited(ip, nextWindow)).toBe(true);
  });

  test("periodic cleanup removes only entries strictly past the window", () => {
    const boundaryIp = freshIp();
    const expiredIp = freshIp();
    for (let i = 0; i < 5; i++) {
      recordFailedAttempt(boundaryIp, t0);
      recordFailedAttempt(expiredIp, t0 - 1);
    }

    cleanupRateLimitState(t0 + WINDOW_MS);

    expect(isRateLimited(boundaryIp, t0 + WINDOW_MS)).toBe(true);
    expect(isRateLimited(expiredIp, t0 - 1 + WINDOW_MS)).toBe(false);
  });
});
