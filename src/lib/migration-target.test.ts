import { describe, expect, test } from "bun:test";
import {
  DEFAULT_TARGET_PROFILE_ID,
  getTargetPlatformPresentation,
  isTargetPlatform,
  supportsMigrationTarget,
  TARGET_PLATFORMS,
} from "./migration-target";

describe("migration target capabilities", () => {
  test("keeps GHEC as the default target", () => {
    expect(DEFAULT_TARGET_PROFILE_ID).toBe("ghec");
    expect(TARGET_PLATFORMS).toEqual(["ghec", "ghes"]);
  });

  test("allows GitLab and Bitbucket to target either GitHub platform", () => {
    for (const provider of ["gitlab", "bitbucket-server"] as const) {
      expect(supportsMigrationTarget(provider, "ghec")).toBe(true);
      expect(supportsMigrationTarget(provider, "ghes")).toBe(true);
    }
  });

  test("allows GitHub sources to target only GHEC", () => {
    expect(supportsMigrationTarget("github", "ghec")).toBe(true);
    expect(supportsMigrationTarget("github", "ghes")).toBe(false);
  });

  test("recognizes only supported target platform values", () => {
    expect(isTargetPlatform("ghec")).toBe(true);
    expect(isTargetPlatform("ghes")).toBe(true);
    expect(isTargetPlatform("github")).toBe(false);
    expect(isTargetPlatform(null)).toBe(false);
    expect(isTargetPlatform(1)).toBe(false);
  });

  test("presents persisted target platforms without URL inference", () => {
    expect(getTargetPlatformPresentation("ghec")).toEqual({
      label: "GHEC",
      displayName: "GitHub Enterprise Cloud",
      icon: "mark-github",
    });
    expect(getTargetPlatformPresentation("ghes")).toEqual({
      label: "GHES",
      displayName: "GitHub Enterprise Server",
      icon: "mark-github",
    });
  });
});
