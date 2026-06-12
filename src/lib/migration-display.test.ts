import { describe, expect, test } from "bun:test";
import type { MigrationState } from "./types";
import {
  ACTIVE_STATES,
  isActiveState,
  isGitHubCloud,
  sourcePlatform,
  STATE_ICONS,
  STATE_STYLES,
} from "./migration-display";

const ALL_STATES: MigrationState[] = [
  "queued",
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
];

describe("isActiveState", () => {
  test("queued/pending/running are active", () => {
    expect(isActiveState("queued")).toBe(true);
    expect(isActiveState("pending")).toBe(true);
    expect(isActiveState("running")).toBe(true);
  });

  test("terminal states are not active", () => {
    expect(isActiveState("succeeded")).toBe(false);
    expect(isActiveState("failed")).toBe(false);
    expect(isActiveState("cancelled")).toBe(false);
  });

  test("ACTIVE_STATES has exactly the three in-flight states", () => {
    expect(ACTIVE_STATES.size).toBe(3);
  });
});

describe("isGitHubCloud / sourcePlatform", () => {
  test("api.github.com is GHEC/cloud", () => {
    expect(isGitHubCloud("https://api.github.com")).toBe(true);
    expect(sourcePlatform("https://api.github.com")).toBe("GHEC");
  });

  test("github.com (non-api) is GHEC/cloud", () => {
    expect(isGitHubCloud("https://github.com")).toBe(true);
    expect(sourcePlatform("https://github.com")).toBe("GHEC");
  });

  test("a data-residency tenant on *.ghe.com is GHEC/cloud", () => {
    expect(isGitHubCloud("https://api.acme.ghe.com/api/v3")).toBe(true);
    expect(sourcePlatform("https://acme.ghe.com")).toBe("GHEC");
  });

  test("a GHES host is not cloud", () => {
    expect(isGitHubCloud("https://ghes.example.com/api/v3")).toBe(false);
    expect(sourcePlatform("https://ghes.example.com/api/v3")).toBe("GHES");
  });

  test("a self-hosted host containing 'github' but not github.com is GHES", () => {
    // e.g. GHES at github.mycompany.com — the substring 'github.com' is absent.
    expect(isGitHubCloud("https://github.mycompany.com/api/v3")).toBe(false);
    expect(sourcePlatform("https://github.mycompany.com/api/v3")).toBe("GHES");
  });

  test("null/undefined is treated as GHES", () => {
    expect(isGitHubCloud(null)).toBe(false);
    expect(sourcePlatform(undefined)).toBe("GHES");
  });
});

describe("state display maps", () => {
  test("every state has a style and an icon", () => {
    for (const s of ALL_STATES) {
      expect(STATE_STYLES[s]).toBeTruthy();
      expect(STATE_ICONS[s]).toBeTruthy();
    }
  });
});
