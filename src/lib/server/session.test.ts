import { describe, expect, test } from "bun:test";
import { createSessionToken, isValidSession, SESSION_MAX_AGE } from "./session";

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
