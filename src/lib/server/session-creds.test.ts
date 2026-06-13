/**
 * Credential-validation tests. `validateCredentials` derives its expected
 * user/pass from env at module load, so we set them before importing the
 * module (the test-setup preload maps `$env/dynamic/private` to process.env).
 */
import { beforeAll, describe, expect, test } from "bun:test";

let validateCredentials: (user: string, pass: string) => boolean;
let authEnabled: boolean;

beforeAll(async () => {
  process.env.GH_MIGRATE_USER = "admin";
  process.env.GH_MIGRATE_PASS = "s3cret-pass";
  const mod = await import("./session");
  validateCredentials = mod.validateCredentials;
  authEnabled = mod.authEnabled;
});

describe("validateCredentials", () => {
  test("authEnabled is true when both env vars are set", () => {
    expect(authEnabled).toBe(true);
  });

  test("accepts the exact configured user and pass", () => {
    expect(validateCredentials("admin", "s3cret-pass")).toBe(true);
  });

  test("rejects a wrong password", () => {
    expect(validateCredentials("admin", "wrong")).toBe(false);
  });

  test("rejects a wrong username", () => {
    expect(validateCredentials("root", "s3cret-pass")).toBe(false);
  });

  test("rejects empty credentials", () => {
    expect(validateCredentials("", "")).toBe(false);
  });

  test("is length-insensitive in comparison (HMAC) — long inputs don't throw", () => {
    expect(validateCredentials("a".repeat(1000), "b".repeat(1000))).toBe(false);
  });
});
