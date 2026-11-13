import { describe, expect, test } from "bun:test";
import { activeAppTab, visibleAppTabs } from "$lib/app-navigation";

describe("application navigation", () => {
  test.each([
    ["/", null],
    ["/login", null],
    ["/profile", "profile"],
    ["/profile/profile-id", "profile"],
    ["/migrate", "migrations"],
    ["/migrate/new", "migrations"],
    ["/migrate/migration-id", "migrations"],
    ["/migrate/batches/batch-id", "migrations"],
    ["/migrate/stats", "statistics"],
    ["/mannequins", "mannequins"],
    ["/setup", "setup"],
    ["/unknown", null],
  ] as const)("selects the tab for %s", (pathname, expected) => {
    expect(activeAppTab(pathname)).toBe(expected);
  });

  test("does not treat similar route names as application routes", () => {
    expect(activeAppTab("/migrations")).toBeNull();
    expect(activeAppTab("/profiles")).toBeNull();
    expect(activeAppTab("/mannequin")).toBeNull();
    expect(activeAppTab("/setup-guide")).toBeNull();
  });

  test("shows Setup while setup is incomplete", () => {
    expect(visibleAppTabs("/migrate", false).map((tab) => tab.id)).toEqual([
      "profile",
      "migrations",
      "statistics",
      "mannequins",
      "setup",
    ]);
  });

  test("keeps Setup discoverable after completion", () => {
    expect(visibleAppTabs("/migrate", true).map((tab) => tab.id)).toEqual([
      "profile",
      "migrations",
      "statistics",
      "mannequins",
      "setup",
    ]);
  });

  test("labels the profile tab consistently with its route", () => {
    expect(visibleAppTabs("/profile", true).find((tab) => tab.id === "profile")?.label).toBe(
      "Profile",
    );
  });

  test("keeps Setup visible while viewing setup after completion", () => {
    expect(visibleAppTabs("/setup", true).map((tab) => tab.id)).toContain("setup");
  });
});
