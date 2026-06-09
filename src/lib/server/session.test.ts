import { describe, expect, test } from "bun:test";
import {
  createSessionToken,
  isRateLimited,
  isValidSession,
  recordFailedAttempt,
  SESSION_MAX_AGE,
} from "./session";

describe("session tokens", () => {
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

  test("rejects malformed tokens", () => {
    expect(isValidSession("")).toBe(false);
    expect(isValidSession("no-dot-here")).toBe(false);
    expect(isValidSession(".")).toBe(false);
  });
});

describe("session expiry", () => {
  const issuedAt = 1_700_000_000_000;
  const maxAgeMs = SESSION_MAX_AGE * 1000;

  test("validates a token within its lifetime", () => {
    const token = createSessionToken(issuedAt);
    expect(isValidSession(token, issuedAt + 60_000)).toBe(true);
  });

  test("validates a token exactly at the expiry boundary", () => {
    const token = createSessionToken(issuedAt);
    expect(isValidSession(token, issuedAt + maxAgeMs)).toBe(true);
  });

  test("rejects a token past its lifetime", () => {
    const token = createSessionToken(issuedAt);
    expect(isValidSession(token, issuedAt + maxAgeMs + 1)).toBe(false);
  });
});

describe("login rate limiting", () => {
  // Each test uses a unique IP so the module-level attempt map stays isolated.
  let ipCounter = 0;
  const freshIp = () => `10.0.0.${ipCounter++}`;

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
});
