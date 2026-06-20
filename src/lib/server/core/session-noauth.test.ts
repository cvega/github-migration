/**
 * Auth-DISABLED credential tests.
 *
 * The main session suites load `session.ts` with GH_MIGRATE_USER/PASS set (by
 * the test-setup preload), so `authEnabled` is always true and the "no creds
 * configured" guard in `validateCredentials` is never exercised. Here we re-mock
 * the env virtual module with NO credentials and load a *fresh* copy of
 * session.ts (a cache-busting import query) so its load-time derivations see
 * auth as disabled — covering the locked-by-default contract.
 *
 * The empty-env mock is restored to `process.env` in afterAll so later suites
 * (and the shared session module) keep seeing the configured credentials.
 */
import { afterAll, describe, expect, mock, test } from "bun:test";

afterAll(() => {
  mock.module("$env/dynamic/private", () => ({ env: process.env }));
});

describe("validateCredentials with auth disabled", () => {
  test("authEnabled is false and all credentials are rejected when none are configured", async () => {
    mock.module("$env/dynamic/private", () => ({ env: {} }));
    // The `?noauth` query forces a fresh module evaluation (separate from the
    // creds-enabled copy the other suites hold). It's built non-literally so
    // `tsc` treats it as a dynamic specifier rather than trying to resolve the
    // path-with-query; the cast restores the module's types.
    const fresh = (await import(`./session.ts?${"noauth"}`)) as typeof import("./session");

    // With no configured creds the feature is off…
    expect(fresh.authEnabled).toBe(false);
    // …and the guard rejects every input — even what would be valid when enabled.
    expect(fresh.validateCredentials("ci-test-admin", "ci-test-pass-7f3a9c")).toBe(false);
    expect(fresh.validateCredentials("", "")).toBe(false);
  });

  test("a half-configured auth (only a username) is treated as disabled", async () => {
    // Auth requires BOTH vars; a single one set must not switch auth on, and
    // must not let validateCredentials proceed (which would hash an undefined
    // password and throw). Covers the `user && pass` / `!user || !pass` guards.
    mock.module("$env/dynamic/private", () => ({ env: { GH_MIGRATE_USER: "ci-test-admin" } }));
    const fresh = (await import(`./session.ts?${"onlyuser"}`)) as typeof import("./session");

    expect(fresh.authEnabled).toBe(false);
    expect(() => fresh.validateCredentials("ci-test-admin", "")).not.toThrow();
    expect(fresh.validateCredentials("ci-test-admin", "")).toBe(false);
  });

  test("a half-configured auth (only a password) is treated as disabled", async () => {
    mock.module("$env/dynamic/private", () => ({
      env: { GH_MIGRATE_PASS: "ci-test-pass-7f3a9c" },
    }));
    const fresh = (await import(`./session.ts?${"onlypass"}`)) as typeof import("./session");

    expect(fresh.authEnabled).toBe(false);
    expect(() => fresh.validateCredentials("", "ci-test-pass-7f3a9c")).not.toThrow();
    expect(fresh.validateCredentials("", "ci-test-pass-7f3a9c")).toBe(false);
  });
});
