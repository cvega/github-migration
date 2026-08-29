import { describe, expect, test } from "bun:test";
import { getExecutorForMigration, getRegisteredMigrationExecutor } from "./registry";

describe("migration executor registry", () => {
  test.each(["github", "gitlab", "bitbucket-server"] as const)(
    "selects the %s GHEC executor",
    (sourceProvider) => {
      const executor = getRegisteredMigrationExecutor({ sourceProvider, targetPlatform: "ghec" });
      expect(typeof executor.run).toBe("function");
      expect(typeof executor.resume).toBe("function");
    },
  );

  test("defaults an omitted provider to GitHub", () => {
    expect(getRegisteredMigrationExecutor({}).run.name).toBe("runGitHubToGhecMigration");
  });

  test.each(["gitlab", "bitbucket-server"] as const)(
    "selects the %s GHES executor",
    (sourceProvider) => {
      const executor = getExecutorForMigration({ sourceProvider, targetPlatform: "ghes" } as never);
      expect(typeof executor.run).toBe("function");
      expect(typeof executor.resume).toBe("function");
    },
  );

  test("rejects GitHub-to-GHES execution", () => {
    expect(() =>
      getRegisteredMigrationExecutor({ sourceProvider: "github", targetPlatform: "ghes" }),
    ).toThrow("cannot migrate to ghes");
  });
});
