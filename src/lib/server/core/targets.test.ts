import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  getMigrationTargetProfile,
  getMigrationTargetProfiles,
  requireMigrationTargetProfile,
} from "./targets";

const KEYS = [
  "GH_TARGET_ORG",
  "GHES_TARGET_ID",
  "GHES_TARGET_NAME",
  "GHES_TARGET_API_URL",
  "GHES_TARGET_ORG",
] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

describe("migration target profiles", () => {
  test("always exposes GHEC as the default target", () => {
    process.env.GH_TARGET_ORG = "  acme,, platform\tacme  ";
    expect(getMigrationTargetProfiles()).toEqual([
      {
        id: "ghec",
        platform: "ghec",
        displayName: "GitHub Enterprise Cloud",
        apiUrl: "https://api.github.com",
        webUrl: "https://github.com",
        organizations: ["acme", "platform"],
      },
    ]);
    expect(getMigrationTargetProfile()).toEqual(getMigrationTargetProfile("ghec"));
    expect(getMigrationTargetProfile("  ghec  ")).toEqual(getMigrationTargetProfile("ghec"));
    expect(requireMigrationTargetProfile()).toEqual(getMigrationTargetProfile("ghec")!);
  });

  test("adds a normalized server-owned GHES profile", () => {
    process.env.GHES_TARGET_ID = " production ";
    process.env.GHES_TARGET_NAME = " Production GHES ";
    process.env.GHES_TARGET_API_URL = "https://ghes.example.com";
    process.env.GHES_TARGET_ORG = "engineering, platform";

    expect(getMigrationTargetProfile("production")).toEqual({
      id: "production",
      platform: "ghes",
      displayName: "Production GHES",
      apiUrl: "https://ghes.example.com/api/v3",
      webUrl: "https://ghes.example.com",
      organizations: ["engineering", "platform"],
    });
  });

  test("uses stable GHES identity defaults", () => {
    process.env.GHES_TARGET_API_URL = "https://ghes.example.com";

    expect(getMigrationTargetProfile("ghes")).toEqual({
      id: "ghes",
      platform: "ghes",
      displayName: "ghes.example.com",
      apiUrl: "https://ghes.example.com/api/v3",
      webUrl: "https://ghes.example.com",
      organizations: [],
    });
  });

  test("rejects invalid, colliding, and cloud GHES configuration", () => {
    for (const [id, url] of [
      ["ghec", "https://ghes.example.com"],
      ["INVALID ID", "https://ghes.example.com"],
      ["!production", "https://ghes.example.com"],
      ["production!", "https://ghes.example.com"],
      ["a".repeat(64), "https://ghes.example.com"],
      ["production", "https://api.github.com"],
      ["production", "https://user:secret@ghes.example.com"],
    ]) {
      process.env.GHES_TARGET_ID = id;
      process.env.GHES_TARGET_API_URL = url;
      expect(getMigrationTargetProfiles()).toHaveLength(1);
    }
  });

  test("fails closed for an unknown target profile", () => {
    expect(getMigrationTargetProfile("missing")).toBeNull();
    expect(() => requireMigrationTargetProfile("missing")).toThrow(/not configured/);
  });
});
