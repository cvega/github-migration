/**
 * Tests for auth config detection, the availability predicates, and the
 * request→App→env priority chain in resolveSourceAuth/resolveTargetAuth.
 *
 * These functions read process.env live, and other test files mutate the same
 * GH_* vars, so each test fully controls the auth env block (saved/restored).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  getAuthConfig,
  isSourceAppConfigured,
  isSourceAuthAvailable,
  isTargetAuthAvailable,
  resolveSourceAuth,
  resolveTargetAuth,
} from "./auth";

const AUTH_ENV_KEYS = [
  "GH_SOURCE_PAT",
  "GH_TARGET_PAT",
  "GH_SOURCE_APP_ID",
  "GH_SOURCE_APP_PRIVATE_KEY",
  "GH_SOURCE_APP_INSTALLATION_ID",
  "GH_TARGET_APP_ID",
  "GH_TARGET_APP_PRIVATE_KEY",
  "GH_TARGET_APP_INSTALLATION_ID",
];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of AUTH_ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of AUTH_ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const PEM = "-----BEGIN KEY-----\nabc\n-----END KEY-----";

function setSourceApp() {
  process.env.GH_SOURCE_APP_ID = "111";
  process.env.GH_SOURCE_APP_PRIVATE_KEY = PEM;
  process.env.GH_SOURCE_APP_INSTALLATION_ID = "222";
}

describe("availability predicates", () => {
  test("no env → nothing configured or available", () => {
    expect(isSourceAppConfigured()).toBe(false);
    expect(isSourceAuthAvailable()).toBe(false);
    expect(isTargetAuthAvailable()).toBe(false);
  });

  test("an env PAT makes auth available but not 'app configured'", () => {
    process.env.GH_SOURCE_PAT = "ghp_x";
    expect(isSourceAuthAvailable()).toBe(true);
    expect(isSourceAppConfigured()).toBe(false);
  });

  test("a complete App config counts as configured and available", () => {
    setSourceApp();
    expect(isSourceAppConfigured()).toBe(true);
    expect(isSourceAuthAvailable()).toBe(true);
  });

  test("a partial App config (missing installation id) does not count", () => {
    process.env.GH_SOURCE_APP_ID = "111";
    process.env.GH_SOURCE_APP_PRIVATE_KEY = PEM;
    // installation id intentionally absent
    expect(isSourceAppConfigured()).toBe(false);
  });
});

describe("getAuthConfig", () => {
  test("reports pat mode with the PAT ceiling when only a PAT is set", () => {
    process.env.GH_SOURCE_PAT = "ghp_x";
    const cfg = getAuthConfig();
    expect(cfg.source.mode).toBe("pat");
    expect(cfg.source.hasEnvPat).toBe(true);
    expect(cfg.source.rateLimit).toBe(5_000);
  });

  test("reports github-app mode with the app ceiling and ids", () => {
    setSourceApp();
    const cfg = getAuthConfig();
    expect(cfg.source.mode).toBe("github-app");
    expect(cfg.source.appId).toBe("111");
    expect(cfg.source.installationId).toBe("222");
    expect(cfg.source.rateLimit).toBe(15_000);
  });
});

describe("resolveSourceAuth priority", () => {
  test("request token wins over everything", () => {
    setSourceApp();
    process.env.GH_SOURCE_PAT = "env-pat";
    expect(resolveSourceAuth("req-token")).toEqual({ token: "req-token" });
  });

  test("request app wins over env when no request token", () => {
    process.env.GH_SOURCE_PAT = "env-pat";
    const result = resolveSourceAuth(undefined, {
      appId: "9",
      privateKey: PEM,
      installationId: "8",
    });
    expect(result).toEqual({ appId: "9", privateKey: PEM, installationId: 8 });
  });

  test("env app is used when no request creds", () => {
    setSourceApp();
    expect(resolveSourceAuth()).toEqual({ appId: "111", privateKey: PEM, installationId: 222 });
  });

  test("env PAT is the last resort before throwing", () => {
    process.env.GH_SOURCE_PAT = "env-pat";
    expect(resolveSourceAuth()).toEqual({ token: "env-pat" });
  });

  test("throws a source-specific error when nothing is available", () => {
    expect(() => resolveSourceAuth()).toThrow(/no source/i);
  });
});

describe("resolveTargetAuth", () => {
  test("throws a target-specific error when nothing is available", () => {
    expect(() => resolveTargetAuth()).toThrow(/no target/i);
  });

  test("uses the target env PAT", () => {
    process.env.GH_TARGET_PAT = "tgt-pat";
    expect(resolveTargetAuth()).toEqual({ token: "tgt-pat" });
  });
});
