import { describe, expect, test } from "bun:test";
import { ALL_MIGRATION_STATES } from "../migration-state";
import {
  isGitHubCloud,
  STATE_ICONS,
  STATE_LABELS,
  STATE_STYLES,
  sourcePlatform,
} from "./migration-display";

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
  test("every state has a label, style, and icon", () => {
    for (const s of ALL_MIGRATION_STATES) {
      expect(STATE_LABELS[s]).toBeTruthy();
      expect(STATE_STYLES[s]).toBeTruthy();
      expect(STATE_ICONS[s]).toBeTruthy();
    }
  });

  test("uses action-oriented labels for transitional states", () => {
    expect(STATE_LABELS.queued).toBe("Waiting");
    expect(STATE_LABELS.pending).toBe("Starting");
    expect(STATE_LABELS.cancelling).toBe("Stopping");
    expect(STATE_LABELS.reconciliation_required).toBe("Needs review");
  });
});
