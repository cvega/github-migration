/**
 * Credential-validation tests. `validateCredentials`/`authEnabled` derive their
 * expected user/pass from env at module load. The test-setup preload sets
 * GH_MIGRATE_USER/PASS before any import (so session.ts loads with them no
 * matter which suite imports it first); these tests read those configured
 * values back from process.env rather than hard-coding them.
 */
import { beforeAll, describe, expect, test } from "bun:test";

let validateCredentials: (user: string, pass: string) => boolean;
let authEnabled: boolean;

// The creds session.ts was configured with (set by the test-setup preload).
const USER = process.env.GH_MIGRATE_USER as string;
const PASS = process.env.GH_MIGRATE_PASS as string;

beforeAll(async () => {
  const mod = await import("./session");
  validateCredentials = mod.validateCredentials;
  authEnabled = mod.authEnabled;
});

describe("validateCredentials", () => {
  test("authEnabled is true when both env vars are set", () => {
    expect(authEnabled).toBe(true);
  });

  test("accepts the exact configured user and pass", () => {
    expect(validateCredentials(USER, PASS)).toBe(true);
  });

  test("rejects a wrong password", () => {
    expect(validateCredentials(USER, `${PASS}-wrong`)).toBe(false);
  });

  test("rejects a wrong username", () => {
    expect(validateCredentials(`not-${USER}`, PASS)).toBe(false);
  });

  test("rejects empty credentials", () => {
    expect(validateCredentials("", "")).toBe(false);
  });

  test("is length-insensitive in comparison (HMAC) — long inputs don't throw", () => {
    expect(validateCredentials("a".repeat(1000), "b".repeat(1000))).toBe(false);
  });
});
