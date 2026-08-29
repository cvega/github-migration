import { describe, expect, test } from "bun:test";
import { DEFAULT_MIGRATION_STATS_FILTERS, parseMigrationStatsFilters } from "./statistics-filters";

describe("parseMigrationStatsFilters", () => {
  test("uses all migrations by default", () => {
    expect(parseMigrationStatsFilters(new URLSearchParams())).toEqual(
      DEFAULT_MIGRATION_STATS_FILTERS,
    );
  });

  test.each([
    ["period", "30d"],
    ["period", "90d"],
    ["period", "all"],
    ["source", "github"],
    ["source", "gitlab"],
    ["source", "bitbucket-server"],
    ["source", "all"],
    ["target", "ghec"],
    ["target", "ghes"],
    ["target", "all"],
    ["mode", "single"],
    ["mode", "batch"],
    ["mode", "all"],
  ])("accepts %s=%s", (parameter, value) => {
    const filters = parseMigrationStatsFilters(new URLSearchParams([[parameter, value]]));

    expect(filters).toEqual({
      ...DEFAULT_MIGRATION_STATS_FILTERS,
      [parameter === "source"
        ? "sourceProvider"
        : parameter === "target"
          ? "targetPlatform"
          : parameter]: value,
    });
  });

  test("falls back independently for invalid values", () => {
    expect(
      parseMigrationStatsFilters(
        new URLSearchParams({
          period: "week",
          source: "azure-devops",
          target: "github.com",
          mode: "scheduled",
        }),
      ),
    ).toEqual(DEFAULT_MIGRATION_STATS_FILTERS);
  });
});
